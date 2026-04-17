const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/generate-outfit', async (req, res) => {
  const { style, colors, occasion, saison, dressing } = req.body;

  if (!style || !occasion || !saison) {
    return res.status(400).json({ error: 'Champs manquants : style, occasion et saison sont requis.' });
  }

  const { forbiddenType } = req.body;
  const dressingLine = dressing ? `Dressing disponible : ${dressing}` : '';

  const prompt = `Tu es Mirror, un ami styliste personnel. Réponds en français, sans markdown, sans tirets, sans listes.

Style : ${style}
Couleurs : ${colors || 'sans préférence'}
Occasion : ${occasion}
Saison : ${saison}${dressingLine ? '\n' + dressingLine : ''}
Type de vêtement interdit cette fois : ${forbiddenType || 'aucun'}

RÈGLE ABSOLUE : Chaque tenue doit être radicalement différente des précédentes. Interdis-toi de répéter ces combinaisons : jamais deux fois le même type de bas (robe, pantalon, jupe, short, combinaison), jamais le même type de chaussures (sandales, mules, escarpins, baskets, boots), jamais le même sac (raphia, cuir, pochette, tote, bandoulière), jamais la même phrase de conclusion. Chaque génération doit surprendre. Varie aussi les matières : lin, soie, coton, velours, denim, satin, broderie. Varie les silhouettes : ajustée, oversize, fluide, structurée, courte, longue.

Structure exacte — respecte les sauts de ligne :
LIGNE 1 : Le nom poétique de la tenue — court, évocateur, sans verbe. Exemple : "L'Heure dorée du dimanche". Le titre doit être complètement différent à chaque fois. Interdis-toi d'utiliser les mots : Éveil, Douceur, Éclat, Nacré. Utilise des registres variés : nature, architecture, musique, voyage, lumière, saison, heure du jour, matière.
LIGNE 2 (vide)
LIGNE 3+ : 2-3 phrases naturelles qui décrivent les pièces concrètes.${dressing ? ' Intègre naturellement une pièce du dressing si elle correspond.' : ''} Glisse 2 ou 3 emojis subtils et bien placés — pas en début de phrase. Termine par une phrase courte et sincère qui donne vraiment confiance. Ne répète jamais la même phrase de conclusion.

Maximum 80 mots. Parle comme un ami, pas comme une publicité.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const outfit = message.content[0].text;
    res.json({ outfit });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la génération de la tenue.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'mirror_v02.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mirror running on port ${PORT}`));
