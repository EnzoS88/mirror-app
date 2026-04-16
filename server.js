require('dotenv').config({ path: require('path').join(__dirname, '.env') });
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

  const dressingLine = dressing ? `Dressing disponible : ${dressing}` : '';

  const prompt = `Tu es Mirror, un ami styliste personnel. Réponds en français, sans markdown, sans tirets, sans listes.

Style : ${style}
Couleurs : ${colors || 'sans préférence'}
Occasion : ${occasion}
Saison : ${saison}${dressingLine ? '\n' + dressingLine : ''}

RÈGLE ABSOLUE : Chaque tenue doit être UNIQUE et DIFFÉRENTE. Même si le style et la saison sont identiques, propose une combinaison de pièces, matières, coupes et accessoires entièrement nouvelles. Ne répète jamais les mêmes associations. Varie systématiquement : les coupes (slim, large, oversize, ajusté), les matières (lin, coton, laine, velours, denim, soie), les superpositions (veste, blazer, cardigan, manteau, trench), et les accessoires (ceinture, sac, bijoux, chapeau, écharpe).

Structure exacte — respecte les sauts de ligne :
LIGNE 1 : Le nom poétique de la tenue — court, évocateur, sans verbe. Exemple : "L'Heure dorée du dimanche"
LIGNE 2 (vide)
LIGNE 3+ : 2-3 phrases naturelles qui décrivent les pièces concrètes.${dressing ? ' Intègre naturellement une pièce du dressing si elle correspond.' : ''} Glisse 2 ou 3 emojis subtils et bien placés — pas en début de phrase. Termine par une phrase courte et sincère qui donne vraiment confiance.

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
