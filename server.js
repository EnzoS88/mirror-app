require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/generate-outfit', async (req, res) => {
  const { style, colors, occasion, saison, dressing } = req.body;

  if (!style || !occasion || !saison) {
    return res.status(400).json({ error: 'Champs manquants : style, occasion et saison sont requis.' });
  }

  const dressingLine = dressing ? `Dressing disponible : ${dressing}` : '';

  const prompt = `Tu es Mirror, un ami styliste. Réponds en français, sans markdown, sans tirets, sans listes.

Style : ${style}
Couleurs : ${colors || 'sans préférence'}
Occasion : ${occasion}
Saison : ${saison}${dressingLine ? '\n' + dressingLine : ''}

Structure exacte — respecte les sauts de ligne :
LIGNE 1 : Le nom poétique de la tenue — court, évocateur, sans verbe. Juste un nom qui donne envie. Exemple : "L'Heure dorée du dimanche"
LIGNE 2 (vide)
LIGNE 3+ : 2-3 phrases naturelles qui décrivent les pièces concrètes.${dressing ? ' Intègre naturellement une pièce du dressing si elle correspond.' : ''} Glisse 2 ou 3 emojis subtils et bien placés dans ce paragraphe — pas en début de phrase, juste pour donner de la vie. Termine par une phrase finale courte, sincère, qui touche l'émotion et donne vraiment confiance.

Maximum 80 mots au total. Parle comme un ami, pas comme une publicité.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const outfit = message.content[0].text;
    res.json({ outfit });
  } catch (error) {
    console.error('Erreur Anthropic:', error.message);
    res.status(500).json({ error: 'Erreur lors de la génération de la tenue.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'mirror_v02.html'));
});

app.listen(port, () => {
  console.log(`Mirror backend démarré sur http://localhost:${port}`);
});
