// team-api.js
// Module qui expose GET /api/team et GET /api/stats pour le site J.B.C Crome,
// exposé en HTTPS via un tunnel Cloudflare (binaire officiel piloté
// directement, sans wrapper npm tiers).
//
// Utilisation dans index.js :
//   const { startTeamApi } = require("./team-api");
//   client.on("clientReady", () => { ...; startTeamApi(client); });

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const express = require("express");
const cors = require("cors");

// ==== CONFIG ====
const GUILD_ID = process.env.GUILD_ID || null;
// Port interne (le tunnel Cloudflare fait une connexion sortante,
// pas besoin que ce soit le port public alloué par l'hébergeur).
const PORT = process.env.TEAM_API_PORT || 26079;

// Mappe chaque clé du site à l'ID du rôle Discord correspondant.
// Clic droit sur le rôle dans Discord (mode développeur activé) -> Copier l'ID.
const ROLE_IDS = {
  patron: "1495109483028807740",
  gerants: "1495109879403385003",
  discord: "1495141640262647989",
  chauffeurs: "1495111013949902999",
  chauffeurs_essai: "1527806431519314183",
};

// Fichier de données du bot (mêmes stats société que /statut et le statut dynamique).
const DATA_PATH = path.join(__dirname, "data.json");

const CLOUDFLARED_BIN = path.join(__dirname, "cloudflared-bin");
const CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
// =================

function resoudreGuild(client) {
  if (GUILD_ID) {
    const g = client.guilds.cache.get(GUILD_ID);
    if (g) return g;
  }
  return client.guilds.cache.first() || null;
}

function chargerDonneesBot() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { guilds: {} };
  }
}

const CACHE_MS = 60 * 1000;
let cache = null;
let cacheTime = 0;
let cacheStats = null;
let cacheStatsTime = 0;
let started = false;

async function buildTeamData(client) {
  const guild = resoudreGuild(client);
  if (!guild) throw new Error("Aucun serveur Discord disponible pour le bot.");

  const members = await guild.members.fetch();

  const result = {};

  for (const [key, roleId] of Object.entries(ROLE_IDS)) {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      result[key] = [];
      continue;
    }

    result[key] = members
      .filter((m) => m.roles.cache.has(role.id))
      .map((m) => ({
        pseudo: m.displayName || m.user.username,
        avatar: m.displayAvatarURL({ extension: "png", size: 128 }),
      }));
  }

  return result;
}

async function getTeamData(client) {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_MS) return cache;
  cache = await buildTeamData(client);
  cacheTime = now;
  return cache;
}

// Nombre de chauffeurs (rôle "chauffeurs") + km/trajets cumulés par la société,
// pour la bannière de stats du site.
async function buildStatsData(client) {
  const guild = resoudreGuild(client);
  if (!guild) throw new Error("Aucun serveur Discord disponible pour le bot.");

  const members = await guild.members.fetch();
  const roleChauffeurs = guild.roles.cache.get(ROLE_IDS.chauffeurs);
  const nbChauffeurs = roleChauffeurs
    ? members.filter((m) => m.roles.cache.has(roleChauffeurs.id)).size
    : 0;

  const botData = chargerDonneesBot();
  let km = 0;
  let trajets = 0;

  for (const guildData of Object.values(botData.guilds || {})) {
    if (guildData && guildData.societe) {
      km += guildData.societe.km || 0;
      trajets += guildData.societe.trajets || 0;
    }
  }

  return { chauffeurs: nbChauffeurs, km, trajets };
}

async function getStatsData(client) {
  const now = Date.now();
  if (cacheStats && now - cacheStatsTime < CACHE_MS) return cacheStats;
  cacheStats = await buildStatsData(client);
  cacheStatsTime = now;
  return cacheStats;
}

// Suit les redirections (github.com/.../latest/download/... redirige 2-3 fois)
function telechargerFichier(url, destPath, redirectsRestants = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "team-api-script" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirectsRestants <= 0) return reject(new Error("Trop de redirections"));
        res.resume();
        return resolve(telechargerFichier(res.headers.location, destPath, redirectsRestants - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Téléchargement échoué, HTTP ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(() => resolve()));
      fileStream.on("error", reject);
    }).on("error", reject);
  });
}

async function assurerBinaireCloudflared() {
  if (fs.existsSync(CLOUDFLARED_BIN)) return;

  console.log("[team-api] binaire cloudflared absent, téléchargement...");
  await telechargerFichier(CLOUDFLARED_URL, CLOUDFLARED_BIN);
  fs.chmodSync(CLOUDFLARED_BIN, 0o755);
  console.log("[team-api] binaire cloudflared installé :", CLOUDFLARED_BIN);
}

async function ouvrirTunnelCloudflare(port) {
  try {
    await assurerBinaireCloudflared();
  } catch (err) {
    console.error("[team-api] impossible de télécharger cloudflared:", err.message);
    console.error("[team-api] le serveur n'est peut-être pas linux-amd64 — dis-moi l'OS de ton hébergeur.");
    return;
  }

  const child = spawn(CLOUDFLARED_BIN, ["tunnel", "--url", `http://localhost:${port}`]);
  let urlTrouvee = false;

  const gererLigne = (buf) => {
    const text = buf.toString();
    console.log("[cloudflared]", text.trim());

    if (!urlTrouvee) {
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        urlTrouvee = true;
        const publicUrl = match[0];
        console.log(`[team-api] tunnel Cloudflare actif : ${publicUrl}`);
        console.log(`[team-api] ⚠️ mets à jour index.html avec :`);
        console.log(`[team-api]    - TEAM_API_URL  = ${publicUrl}/api/team`);
        console.log(`[team-api]    - STATS_API_URL = ${publicUrl}/api/stats`);
      }
    }
  };

  child.stdout.on("data", gererLigne);
  child.stderr.on("data", gererLigne);

  child.on("exit", (code) => {
    console.error(`[team-api] cloudflared s'est arrêté (code ${code}).`);
  });

  child.on("error", (err) => {
    console.error("[team-api] impossible de lancer cloudflared:", err.message);
  });
}

function startTeamApi(client, options = {}) {
  if (started) {
    console.warn("[team-api] déjà démarré, appel ignoré.");
    return;
  }
  started = true;

  const port = options.port || PORT;
  const app = express();
  app.use(cors());
  app.options("*", cors());

  app.get("/api/team", async (req, res) => {
    try {
      const data = await getTeamData(client);
      res.json(data);
    } catch (err) {
      console.error("[team-api] erreur:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.get("/api/stats", async (req, res) => {
    try {
      const data = await getStatsData(client);
      res.json(data);
    } catch (err) {
      console.error("[team-api] erreur stats:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.listen(port, "0.0.0.0", async () => {
    console.log(`[team-api] écoute en interne sur le port ${port}`);
    await ouvrirTunnelCloudflare(port);
  });
}

module.exports = { startTeamApi };
