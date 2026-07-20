/**
 * team-api.js
 * ---------------------------------------------------
 * Petit endpoint HTTP à greffer sur un bot discord.js existant
 * (ScaraBot / NosixBot) pour exposer la composition de l'équipe
 * en JSON, lue en temps réel depuis les rôles du serveur Discord.
 *
 * INSTALLATION
 *   npm install express cors
 *
 * CONFIG À FAIRE
 *   1. Renseigne GUILD_ID plus bas (l'ID de ton serveur Discord).
 *   2. Renseigne les IDs de rôle dans ROLE_MAP.
 *   3. Ouvre le port choisi (PORT) sur ton hébergeur (DisHost/Pterodactyl).
 *   4. Mets l'URL publique résultante (ex: https://tondomaine:3001/api/team)
 *      dans le site, à la place de TEAM_API_URL.
 *
 * UTILISATION (dans ton fichier principal du bot, après client.login) :
 *   const { startTeamApi } = require('./team-api');
 *   startTeamApi(client);
 */

const express = require('express');
const cors = require('cors');

// -------- CONFIG --------
const GUILD_ID = '1492875979142598716 ';
const PORT = 26079;

// Associe chaque catégorie affichée sur le site à l'ID du rôle Discord correspondant
const ROLE_MAP = {
  patron:           '1495109483028807740',
  gerants:          '1495109879403385003',
  discord:          '1495141640262647989',
  chauffeurs:       '1495111013949902999',
  chauffeurs_essai: '1527806431519314183',
};

// Autorise uniquement ton site à appeler cette API.
// Doit être l'origine EXACTE (protocole + domaine), sans chemin ni slash final,
// sinon le navigateur bloque la requête CORS.
const ALLOWED_ORIGINS = ['https://nosix-dev.github.io', 'http://127.0.0.1:5500'];
// -------------------------

function startTeamApi(client) {
  const app = express();
  app.use(cors({ origin: ALLOWED_ORIGIN }));

  // petit cache pour éviter de re-fetch les membres à chaque requête
  let cache = { data: null, ts: 0 };
  const CACHE_MS = 60 * 1000; // 1 minute

  app.get('/api/team', async (req, res) => {
    try {
      if (cache.data && Date.now() - cache.ts < CACHE_MS) {
        return res.json(cache.data);
      }

      const guild = await client.guilds.fetch(GUILD_ID);
      // force le fetch complet des membres (nécessite l'intent GuildMembers)
      const members = await guild.members.fetch();

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

  app.listen(PORT, () => {
    console.log(`[team-api] en écoute sur le port ${PORT}`);
  });
}

module.exports = { startTeamApi };