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
  const { style, colors, occasion, saison } = req.body;

  if (!style || !occasion || !saison) {
    return res.status(400).json({ error: 'Champs manquants : style, occasion et saison sont requis.' });
  }

  const prompt = `Tu es un styliste expert. Génère une tenue complète et détaillée pour la situation suivante :

- Style vestimentaire : ${style}
- Couleurs préférées : ${colors || 'pas de préférence'}
- Occasion : ${occasion}
- Saison : ${saison}

Réponds en français avec :
1. **Tenue principale** : description précise de chaque pièce (haut, bas, chaussures, accessoires)
2. **Palette de couleurs** : comment combiner les couleurs choisies
3. **Conseil styliste** : un conseil pratique pour sublimer cette tenue
4. **Alternatives** : 2 variantes selon l'humeur du jour

Sois précis, inspirant et accessible.`;

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
