require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Clients ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Auth helper ──
async function getUserFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── Routes auth ──

// Mettre à jour le genre (une seule fois à l'inscription)
app.post('/api/update-genre', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { genre } = req.body;
  if (!['Femme', 'Homme', 'Enfant'].includes(genre)) {
    return res.status(400).json({ error: 'Genre invalide' });
  }

  // Vérifier que le genre n'est pas déjà défini
  const { data: existing } = await supabase
    .from('users')
    .select('genre')
    .eq('id', user.id)
    .single();

  if (existing?.genre) {
    return res.status(403).json({ error: 'Genre déjà défini, non modifiable.' });
  }

  const { error } = await supabase
    .from('users')
    .update({ genre })
    .eq('id', user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Récupérer le dressing de l'utilisateur
app.get('/api/dressing', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { data, error } = await supabase
    .from('dressing')
    .select('vetements')
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json({ vetements: data?.vetements || '' });
});

// Sauvegarder le dressing (upsert)
app.post('/api/save-dressing', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { vetements } = req.body;
  if (vetements === undefined) return res.status(400).json({ error: 'Champ vetements requis' });

  const { error } = await supabase
    .from('dressing')
    .upsert({ user_id: user.id, vetements, updated_at: new Date().toISOString() },
             { onConflict: 'user_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Sauvegarder une tenue générée
app.post('/api/save-tenue', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { titre, contenu } = req.body;
  if (!titre || !contenu) return res.status(400).json({ error: 'Titre et contenu requis' });

  const { error } = await supabase
    .from('tenues')
    .insert({ user_id: user.id, titre, contenu });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Génération de tenue ──
app.post('/api/generate-outfit', async (req, res) => {
  const { style, colors, occasion, saison, dressing, forbiddenType } = req.body;

  if (!style || !occasion || !saison) {
    return res.status(400).json({ error: 'Champs manquants : style, occasion et saison sont requis.' });
  }

  const dressingLine = dressing ? `Dressing disponible : ${dressing}` : '';

  const prompt = `Tu es Mirror, un ami styliste personnel. Réponds en français, sans markdown, sans tirets, sans listes.

Style : ${style}
Couleurs : ${colors || 'sans préférence'}
Occasion : ${occasion}
Saison : ${saison}${dressingLine ? '\n' + dressingLine : ''}
Type de vêtement interdit cette fois : ${forbiddenType || 'aucun'}

RÈGLE ABSOLUE : Chaque tenue doit être radicalement différente des précédentes. Interdis-toi de répéter ces combinaisons : jamais deux fois le même type de bas (robe, pantalon, jupe, short, combinaison), jamais le même type de chaussures (sandales, mules, escarpins, baskets, boots), jamais le même sac (raphia, cuir, pochette, tote, bandoulière), jamais la même phrase de conclusion. Chaque génération doit surprendre. Varie aussi les matières : lin, soie, coton, velours, denim, satin, broderie. Varie les silhouettes : ajustée, oversize, fluide, structurée, courte, longue.

DENIM OBLIGATOIRE — intègre régulièrement du jean/denim dans les suggestions : jean slim, jean large, jean taille haute, veste en jean, jupe en jean. Ne propose pas que du lin et de la soie.

TON PLUS FORT — parle comme une vraie amie directe et confiante, pas comme une pub élégante. Moins de douceur, plus de caractère.

PHRASES DE CONCLUSION INTERDITES — ne jamais utiliser : 'tout le monde va se retourner', 'parle avant que tu ouvres la bouche', 'rayonner sans même y penser', 'longueur d'avance', 'tu vas entrer dans cette pièce', 'exactement à ta place', 'te ressemble avant même'. Chaque conclusion doit être une image concrète et inattendue — pas une promesse vague. Exemple : 'Ce soir tu poses ton sac et tu n'as plus qu'à sourire.'

MATIÈRES — varie systématiquement : lin, soie, coton, satin, velours, denim, jersey, broderie anglaise, dentelle, mousseline. Ne propose pas deux fois de suite la même matière principale. Le lin blanc est interdit deux fois de suite — si la tenue précédente était en lin, impose une matière différente.

ACCESSOIRES — varie obligatoirement : sac baguette, tote bag, clutch, mini sac structuré, sac bandoulière chaîne, panier osier, sac à main rigide. Le sac hobo est interdit plus de 2 fois sur 5 générations. Jamais deux fois 'pochette structurée' ou 'mules' consécutivement.

TITRES — interdis ces mots : 'Terrasse', 'Douceur', 'Florence', 'Lisbonne', 'Éveil', 'Nacré', 'marbre blanc', 'après-midi', 'Quai'. Utilise des univers encore plus variés : une sensation physique, une matière, un son, une couleur, un marché, un jardin, une heure précise, une émotion inattendue. Exemples : 'Cinq heures à Séville', 'Le Grain du Sable chaud', 'Un Mardi à Montmartre'.

LONGUEUR — le corps de la tenue doit contenir exactement 3 phrases, ni plus ni moins. Des phrases courtes et concrètes, pas de phrases trop longues.

Structure exacte — respecte les sauts de ligne :
LIGNE 1 : Le nom poétique de la tenue — court, évocateur, sans verbe. Exemple : "L'Heure dorée du dimanche". Le titre doit être unique et jamais répété — interdis 'marbre blanc', 'après-midi', 'éveil', 'nacré'. Pioche dans des univers différents à chaque fois : une ville, une heure, une matière, un lieu, une sensation.
LIGNE 2 (vide)
LIGNE 3+ : Exactement 3 phrases naturelles qui décrivent les pièces concrètes.${dressing ? ' Intègre naturellement une pièce du dressing si elle correspond.' : ''} Pas d'emojis dans le corps du texte. Termine par une phrase courte et sincère qui donne vraiment confiance, suivie de ✨ comme unique signature Mirror. Ne répète jamais la même phrase de conclusion.

Maximum 80 mots. Parle comme un ami, pas comme une publicité.`;

  try {
    const message = await anthropic.messages.create({
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

// ── Pages ──
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'reset-password.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'mirror_v02.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mirror running on port ${PORT}`));
