// scripts/notify-discord.js
// Détecte les nouveaux événements (events.json) et les nouvelles photos
// (dossier galerie/) entre deux commits, et envoie un message Discord
// via un webhook pour chacun.

const { execSync } = require('child_process');

const [, , before, after] = process.argv;
const webhook = process.env.DISCORD_WEBHOOK_URL;
const repo = process.env.GITHUB_REPOSITORY || '';
const branche = 'main';

const AVANT_VIDE = '0000000000000000000000000000000000000000';

function gitShow(ref, chemin){
  if(ref === AVANT_VIDE) return null;
  try{
    return execSync(`git show ${ref}:${chemin}`, { encoding: 'utf8' });
  }catch(e){
    return null; // fichier absent à cette révision
  }
}

function jsonSecurise(texte){
  if(!texte) return [];
  try{
    const data = JSON.parse(texte);
    return Array.isArray(data) ? data : [];
  }catch(e){
    return [];
  }
}

async function envoyerDiscord(payload){
  if(!webhook){
    console.warn('DISCORD_WEBHOOK_URL non configuré — message ignoré.');
    return;
  }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if(!res.ok){
    console.error('Erreur webhook Discord :', res.status, await res.text());
  }
}

function cleEvenement(ev){
  return (ev.titre || '') + '|' + (ev.date || '');
}

async function notifierNouveauxEvenements(){
  const avant = jsonSecurise(gitShow(before, 'events.json'));
  const apres = jsonSecurise(gitShow(after, 'events.json'));

  const clesAvant = new Set(avant.map(cleEvenement));
  const nouveaux = apres.filter(ev => !clesAvant.has(cleEvenement(ev)));

  for(const ev of nouveaux){
    const champs = [];
    if(ev.date){
      const d = new Date(ev.date);
      champs.push({ name: 'Date', value: isNaN(d) ? String(ev.date) : d.toLocaleString('fr-FR'), inline: true });
    }
    if(ev.lieu) champs.push({ name: 'Lieu', value: ev.lieu, inline: true });

    const description = Array.isArray(ev.description)
      ? ev.description.join('\n')
      : (ev.description || '');

    await envoyerDiscord({
      content: '🆕 **Nouvel événement ajouté !**',
      embeds: [{
        title: ev.titre || 'Sans titre',
        description: description.slice(0, 4000),
        url: ev.lien || undefined,
        color: 0xc62828,
        fields: champs,
        image: ev.image ? { url: ev.image } : undefined,
      }],
    });
  }

  return nouveaux.length;
}

async function notifierNouvellesPhotos(){
  let sortie;
  try{
    sortie = execSync(`git diff --name-status ${before === AVANT_VIDE ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : before} ${after} -- galerie`, { encoding: 'utf8' });
  }catch(e){
    console.warn('Impossible de calculer le diff des photos :', e.message);
    return 0;
  }

  const fichiersAjoutes = sortie
    .split('\n')
    .filter(Boolean)
    .filter(ligne => ligne.startsWith('A\t'))
    .map(ligne => ligne.split('\t')[1])
    .filter(chemin => /\.(jpe?g|png|webp|gif)$/i.test(chemin));

  if(!fichiersAjoutes.length) return 0;

  // Regroupe les photos par album (sous-dossier de galerie/)
  const parAlbum = {};
  for(const chemin of fichiersAjoutes){
    const parties = chemin.split('/'); // galerie/<album>/<fichier> ou galerie/<fichier>
    const album = parties.length > 2 ? parties[1] : 'Photos';
    (parAlbum[album] = parAlbum[album] || []).push(chemin);
  }

  for(const [album, fichiers] of Object.entries(parAlbum)){
    const urlPremierePhoto = `https://raw.githubusercontent.com/${repo}/${branche}/${fichiers[0]}`;
    await envoyerDiscord({
      content: '📸 **Nouvelle(s) photo(s) ajoutée(s) à la galerie !**',
      embeds: [{
        title: `${fichiers.length} photo${fichiers.length > 1 ? 's' : ''} — ${album}`,
        color: 0x5fd1ff,
        image: { url: urlPremierePhoto },
      }],
    });
  }

  return fichiersAjoutes.length;
}

async function main(){
  const nbEvents = await notifierNouveauxEvenements();
  const nbPhotos = await notifierNouvellesPhotos();
  console.log(`Terminé : ${nbEvents} nouvel(s) événement(s), ${nbPhotos} nouvelle(s) photo(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
