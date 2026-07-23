// team-api.js
// Module qui expose GET /api/team et GET /api/stats pour le site J.B.C Crome,
// exposé en HTTPS via un tunnel ngrok (domaine gratuit fixe, binaire officiel
// piloté directement, sans wrapper npm tiers).
//
// Utilisation dans index.js :
//   const { startTeamApi } = require("./team-api");
//   client.on("clientReady", () => { ...; startTeamApi(client); });
//
// Variables .env requises :
//   NGROK_AUTHTOKEN = ton authtoken (dashboard ngrok -> "Your Authtoken")
//   NGROK_DOMAIN    = ton domaine gratuit assigné (dashboard ngrok -> Gateway > Domains,
//                     type xxxxx.ngrok-free.dev). NE PAS mettre https:// devant.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execFileSync } = require("child_process");
const express = require("express");
const cors = require("cors");

// ==== CONFIG ====
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = process.env.TEAM_API_PORT || 26079;

const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || null;
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || null;

const ROLE_IDS = {
  patron: "1495109483028807740",
  gerants: "1495109879403385003",
  discord: "1495141640262647989",
  chauffeurs: "1495111013949902999",
  chauffeurs_essai: "1527806431519314183",
};

const DATA_PATH = path.join(__dirname, "data.json");

const NGROK_DIR = path.join(__dirname, "ngrok-bin");
const NGROK_BIN = path.join(NGROK_DIR, "ngrok");
const NGROK_TARBALL = path.join(NGROK_DIR, "ngrok.tgz");
const NGROK_URL = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz";
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
const MEMBERS_CACHE_MS = 5 * 60 * 1000;
let membersCache = null;
let membersCacheTime = 0;
let membersFetchPromise = null;

let cache = null;
let cacheTime = 0;
let cacheStats = null;
let cacheStatsTime = 0;
let started = false;

async function getGuildMembers(guild) {
  const now = Date.now();
  if (membersCache && now - membersCacheTime < MEMBERS_CACHE_MS) {
    return membersCache;
  }

  if (!membersFetchPromise) {
    membersFetchPromise = guild.members.fetch()
      .then((members) => {
        membersCache = members;
        membersCacheTime = Date.now();
        return members;
      })
      .catch((err) => {
        membersFetchPromise = null;
        throw err;
      });

    membersFetchPromise.finally(() => {
      membersFetchPromise = null;
    });
  }

  return membersFetchPromise;
}

async function buildTeamData(client) {
  const guild = resoudreGuild(client);
  if (!guild) throw new Error("Aucun serveur Discord disponible pour le bot.");

  const members = await getGuildMembers(guild);
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

async function buildStatsData(client) {
  const guild = resoudreGuild(client);
  if (!guild) throw new Error("Aucun serveur Discord disponible pour le bot.");

  const members = await getGuildMembers(guild);
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

async function assurerBinaireNgrok() {
  if (fs.existsSync(NGROK_BIN)) return;

  if (!fs.existsSync(NGROK_DIR)) fs.mkdirSync(NGROK_DIR, { recursive: true });

  console.log("[team-api] binaire ngrok absent, téléchargement...");
  await telechargerFichier(NGROK_URL, NGROK_TARBALL);

  console.log("[team-api] extraction...");
  execFileSync("tar", ["xzf", NGROK_TARBALL, "-C", NGROK_DIR]);
  fs.chmodSync(NGROK_BIN, 0o755);
  fs.unlinkSync(NGROK_TARBALL);

  console.log("[team-api] binaire ngrok installé :", NGROK_BIN);
}

async function ouvrirTunnelNgrok(port) {
  if (!NGROK_AUTHTOKEN) {
    console.error("[team-api] NGROK_AUTHTOKEN manquant dans le .env — impossible de lancer le tunnel.");
    return;
  }
  if (!NGROK_DOMAIN) {
    console.error("[team-api] NGROK_DOMAIN manquant dans le .env — impossible de lancer le tunnel.");
    return;
  }

  try {
    await assurerBinaireNgrok();
  } catch (err) {
    console.error("[team-api] impossible de télécharger/extraire ngrok:", err.message);
    console.error("[team-api] vérifie que 'tar' est disponible sur l'hébergeur, et que l'OS est bien linux-amd64.");
    return;
  }

  const child = spawn(
    NGROK_BIN,
    ["http", `--url=${NGROK_DOMAIN}`, String(port)],
    { env: { ...process.env, NGROK_AUTHTOKEN } }
  );

  let annonce = false;
  const gererLigne = (buf) => {
    const text = buf.toString();
    console.log("[ngrok]", text.trim());

    if (!annonce && /started tunnel|client session established/i.test(text)) {
      annonce = true;
      console.log(`[team-api] tunnel ngrok actif : https://${NGROK_DOMAIN}`);
      console.log(`[team-api] ⚠️ mets à jour index.html avec :`);
      console.log(`[team-api]    - TEAM_API_URL  = https://${NGROK_DOMAIN}/api/team`);
      console.log(`[team-api]    - STATS_API_URL = https://${NGROK_DOMAIN}/api/stats`);
    }
  };

  child.stdout.on("data", gererLigne);
  child.stderr.on("data", gererLigne);

  child.on("exit", (code) => {
    console.error(`[team-api] ngrok s'est arrêté (code ${code}). Relance dans 5s...`);
    setTimeout(() => ouvrirTunnelNgrok(port), 5000);
  });

  child.on("error", (err) => {
    console.error("[team-api] impossible de lancer ngrok:", err.message);
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
    await ouvrirTunnelNgrok(port);
  });
}

module.exports = { startTeamApi };
