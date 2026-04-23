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

PHRASES DE CONCLUSION INTERDITES — ne jamais utiliser : 'tout le monde va se retourner', 'parle avant que tu ouvres la bouche', 'rayonner sans même y penser', 'longueur d'avance', 'tu vas entrer dans cette pièce', 'exactement à ta place', 'te ressemble avant même'. Chaque conclusion doit être une image concrète et inattendue — pas une promesse vague. Exemple : 'Ce soir tu poses ton sac et tu n'as plus qu'à sourire.'

MATIÈRES — varie systématiquement : lin, soie, coton, satin, velours, denim, jersey, broderie anglaise, dentelle, mousseline. Ne propose pas deux fois de suite la même matière principale. Le lin blanc est interdit deux fois de suite — si la tenue précédente était en lin, impose une matière différente.

ACCESSOIRES — varie obligatoirement : sac baguette, tote bag, clutch, mini sac structuré, sac bandoulière chaîne, panier osier, sac à main rigide. Le sac hobo est interdit plus de 2 fois sur 5 générations. Jamais deux fois 'pochette structurée' ou 'mules' consécutivement.

TITRES — interdis ces mots : 'Terrasse', 'Douceur', 'Florence', 'Lisbonne', 'Éveil', 'Nacré', 'marbre blanc', 'après-midi', 'Quai'. Utilise des univers encore plus variés : une sensation physique, une matière, un son, une couleur, un marché, un jardin, une heure précise, une émotion inattendue. Exemples : 'Cinq heures à Séville', 'Le Grain du Sable chaud', 'Un Mardi à Montmartre'.

LONGUEUR — le corps de la tenue doit contenir exactement 3 phrases, ni plus ni moins. Des phrases courtes et concrètes, pas de phrases trop longues.

DENIM OBLIGATOIRE — intègre régulièrement du jean/denim dans les suggestions : jean slim, jean large, jean taille haute, veste en jean, jupe en jean. Ne propose pas que du lin et de la soie — varie vraiment les matières du quotidien.

TON — parle comme une vraie amie directe et confiante, pas comme une pub élégante. Moins de douceur, plus de caractère. Exemple de ton : 'Cette tenue tu vas tout déchirer' plutôt que 'tu vas rayonner avec élégance'.

Structure exacte — respecte les sauts de ligne :
LIGNE 1 : Le nom poétique de la tenue — court, évocateur, sans verbe. Exemple : "L'Heure dorée du dimanche". Le titre doit être unique et jamais répété — interdis 'marbre blanc', 'après-midi', 'éveil', 'nacré'. Pioche dans des univers différents à chaque fois : une ville, une heure, une matière, un lieu, une sensation.
LIGNE 2 (vide)
LIGNE 3+ : 2-3 phrases naturelles qui décrivent les pièces concrètes.${dressing ? ' Intègre naturellement une pièce du dressing si elle correspond.' : ''} Pas d'emojis dans le corps du texte. Termine par une phrase courte et sincère qui donne vraiment confiance, suivie de ✨ comme unique signature Mirror. Ne répète jamais la même phrase de conclusion.

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
