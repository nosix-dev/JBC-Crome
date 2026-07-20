/**
 * team-api.js
 * ---------------------------------------------------
 * Petit endpoint HTTP à greffer sur un bot discord.js existant
 * (ScaraBot / NosixBot) pour exposer la composition de l'équipe
 * en JSON, lue en temps réel depuis les rôles du serveur Discord.
 *
 * INSTALLATION
 *   npm install express cors @ngrok/ngrok
 *
 * CONFIG À FAIRE
 *   1. Renseigne GUILD_ID plus bas (l'ID de ton serveur Discord).
 *   2. Renseigne les IDs de rôle dans ROLE_MAP.
 *   3. Dans le .env du bot, ajoute :
 *        NGROK_AUTHTOKEN=ton_authtoken_ngrok
 *        NGROK_DOMAIN=ton-domaine.ngrok-free.dev (ou .app selon ce que ngrok t'a donné)
 *   4. Au démarrage, un tunnel HTTPS public s'ouvre automatiquement sur ce
 *      domaine fixe. L'URL s'affiche aussi dans les logs, mais elle ne
 *      change plus d'un redémarrage à l'autre — à mettre une seule fois
 *      dans TEAM_API_URL du site.
 *
 * UTILISATION (dans ton fichier principal du bot, après client.login) :
 *   const { startTeamApi } = require('./team-api');
 *   startTeamApi(client);
 */

const express = require('express');
const cors = require('cors');
const ngrok = require('@ngrok/ngrok');

const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN;
const NGROK_DOMAIN = process.env.NGROK_DOMAIN;

// -------- CONFIG --------
const GUILD_ID = '1492875979142598716';
const PORT = 26079;

// Associe chaque catégorie affichée sur le site à l'ID du rôle Discord correspondant
const ROLE_MAP = {
  patron:           '1495109483028807740',
  gerants:          '1495109879403385003',
  discord:          '1495141640262647989',
  chauffeurs:       '1495111013949902999',
  chauffeurs_essai: '1527806431519314183',
};

// Autorise uniquement ces origines à appeler cette API.
// Chaque entrée doit être l'origine EXACTE (protocole + domaine), sans chemin ni slash final,
// sinon le navigateur bloque la requête CORS.
// Retire 'http://127.0.0.1:5500' une fois les tests locaux terminés, pour ne garder que le site en prod.
const ALLOWED_ORIGINS = ['https://nosix-dev.github.io', 'http://127.0.0.1:5500'];
// -------------------------

function startTeamApi(client) {
  const app = express();
  app.use(cors({ origin: ALLOWED_ORIGINS }));

  // petit cache pour éviter de re-fetch les membres à chaque requête
  let cache = { data: null, ts: 0 };
  const CACHE_MS = 60 * 1000; // 1 minute

  app.get('/api/team', async (req, res) => {
    try {
      if (cache.data && Date.now() - cache.ts < CACHE_MS) {
        return res.json(cache.data);
      }

      const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
      // réutilise le cache des membres déjà chargé par le bot au démarrage
      // (évite de re-fetch à chaque appel API et de se faire rate-limit par Discord)
      const members = guild.members.cache.size > 0
        ? guild.members.cache
        : await guild.members.fetch();

      const result = {};
      for (const [key, roleId] of Object.entries(ROLE_MAP)) {
        result[key] = members
          .filter(m => m.roles.cache.has(roleId))
          .map(m => ({ pseudo: m.displayName }))
          .sort((a, b) => a.pseudo.localeCompare(b.pseudo));
      }

      cache = { data: result, ts: Date.now() };
      res.json(result);
    } catch (err) {
      console.error('[team-api] erreur:', err);
      res.status(500).json({ error: 'Impossible de récupérer l\'équipe.' });
    }
  });

  async function ouvrirTunnel() {
    try {
      const listener = await ngrok.forward({
        addr: PORT,
        authtoken: NGROK_AUTHTOKEN,
        domain: NGROK_DOMAIN,
      });

      const url = listener.url();
      console.log(`[team-api] URL publique HTTPS : ${url}`);
      console.log(`[team-api] → à mettre dans le site : ${url}/api/team`);
    } catch (err) {
      console.error('[team-api] impossible d\'ouvrir le tunnel ngrok:', err.message);
      setTimeout(ouvrirTunnel, 10000);
    }
  }

  app.listen(PORT, () => {
    console.log(`[team-api] en écoute sur le port ${PORT}`);
    ouvrirTunnel();
  });
}

module.exports = { startTeamApi };
