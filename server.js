require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');

// Initialisation défensive : ne crash pas si la clé n'est pas encore configurée
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

if (!stripe) console.warn('⚠️  STRIPE_SECRET_KEY manquante — les paiements sont désactivés.');

const app = express();

// ── Webhook Stripe : raw body AVANT express.json() ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configuré' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const plan   = session.metadata?.plan || 'standard';

    if (userId) {
      const { error } = await supabase
        .from('users')
        .update({ role: plan })
        .eq('id', userId);

      if (error) console.error('Webhook: update role error:', error.message);
      else console.log(`Webhook: user ${userId} → role '${plan}'`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;

    // Retrouver l'utilisateur via stripe_customer_id ou email
    const customer = await stripe.customers.retrieve(customerId);
    const email = customer.email;
    if (email) {
      const { error } = await supabase
        .from('users')
        .update({ role: 'free' })
        .eq('email', email);

      if (error) console.error('Webhook: downgrade error:', error.message);
      else console.log(`Webhook: ${email} downgraded → 'free'`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Clients (défensifs — ne crashent pas si une clé manque) ──
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : (() => { console.warn('⚠️  ANTHROPIC_API_KEY manquante'); return null; })();

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : (() => { console.warn('⚠️  SUPABASE_URL / SUPABASE_SECRET_KEY manquantes'); return null; })();

// ── Auth helper ──
async function getUserFromToken(req) {
  if (!supabase) return null;
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
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('GET /api/dressing error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ vetements: data?.vetements || '' });
});

// Sauvegarder le dressing (select → update ou insert)
app.post('/api/save-dressing', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { vetements } = req.body;
  if (vetements === undefined) return res.status(400).json({ error: 'Champ vetements requis' });

  // Limite dressing pour les comptes gratuits
  const FREE_DRESSING_LIMIT = 20;
  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).maybeSingle();
  const role = profile?.role || 'free';
  const isUnlimited = ['standard', 'premium', 'admin'].includes(role);

  if (!isUnlimited && vetements.trim()) {
    const pieces = vetements.split(',').filter(p => p.trim().length > 0).length;
    if (pieces > FREE_DRESSING_LIMIT) {
      return res.status(403).json({
        code: 'DRESSING_LIMIT',
        error: `Limite de ${FREE_DRESSING_LIMIT} pièces atteinte pour les comptes gratuits.`
      });
    }
  }

  // Chercher si une ligne existe déjà pour cet utilisateur
  const { data: existing, error: selectError } = await supabase
    .from('dressing')
    .select('id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (selectError) {
    console.error('save-dressing select error:', selectError);
    return res.status(500).json({ error: selectError.message });
  }

  let error;
  if (existing) {
    ({ error } = await supabase
      .from('dressing')
      .update({ vetements, updated_at: new Date().toISOString() })
      .eq('id', existing.id));
  } else {
    ({ error } = await supabase
      .from('dressing')
      .insert({ user_id: user.id, vetements }));
  }

  if (error) {
    console.error('save-dressing write error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

// Sauvegarder une tenue générée
app.post('/api/save-tenue', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { titre, contenu, style, occasion, saison } = req.body;
  if (!titre || !contenu) return res.status(400).json({ error: 'Titre et contenu requis' });

  const { error } = await supabase
    .from('tenues')
    .insert({ user_id: user.id, titre, contenu, style: style || null, occasion: occasion || null, saison: saison || null });

  if (error) {
    console.error('save-tenue error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

// Récupérer l'historique des tenues
app.get('/api/tenues', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { data, error } = await supabase
    .from('tenues')
    .select('id, titre, contenu, style, occasion, saison, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('GET /api/tenues error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ tenues: data });
});

// ── Rate limiter : 10 req/min/IP sur generate-outfit ──
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Réessaie dans une minute.' },
});

// ── Génération de tenue ──
app.post('/api/generate-outfit', generateLimiter, async (req, res) => {
  const { style, colors, occasion, saison, dressing, forbiddenType } = req.body;

  if (!style || !occasion || !saison) {
    return res.status(400).json({ error: 'Champs manquants : style, occasion et saison sont requis.' });
  }

  // ── Auth obligatoire ──
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise pour générer une tenue.' });

  const DAILY_LIMIT = 3;

  if (user) {
    const today = new Date().toISOString().split('T')[0];

    // Récupérer le rôle de l'utilisateur
    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    const role = profile?.role || 'free';
    const isUnlimited = role === 'standard' || role === 'premium' || role === 'admin';

    if (!isUnlimited) {
      const { data: usage } = await supabase
        .from('daily_usage')
        .select('id, count')
        .eq('user_id', user.id)
        .eq('date', today)
        .maybeSingle();

      const currentCount = usage?.count || 0;

      if (currentCount >= DAILY_LIMIT) {
        return res.status(429).json({
          code: 'DAILY_LIMIT_REACHED',
          used: currentCount,
          limit: DAILY_LIMIT,
          role
        });
      }

      res.locals.usage = usage;
      res.locals.currentCount = currentCount;
      res.locals.today = today;
    }

    res.locals.user = user;
    res.locals.role = role;
    res.locals.isUnlimited = isUnlimited;
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

  if (!anthropic) {
    return res.status(503).json({ error: 'Service IA non configuré. Contacte le support.' });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const outfit = message.content[0].text;

    // Incrémenter le compteur journalier (seulement pour les utilisateurs non-illimités)
    const { user, usage, currentCount, today, isUnlimited } = res.locals;
    if (user && !isUnlimited) {
      if (usage) {
        await supabase.from('daily_usage')
          .update({ count: currentCount + 1 })
          .eq('id', usage.id);
      } else {
        await supabase.from('daily_usage')
          .insert({ user_id: user.id, date: today, count: 1 });
      }
    }

    const remaining = (user && !isUnlimited) ? (DAILY_LIMIT - (currentCount + 1)) : null;
    res.json({ outfit, remaining });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la génération de la tenue.' });
  }
});

// ── Admin : modifier le rôle d'un utilisateur ──
app.post('/api/admin/update-role', async (req, res) => {
  const caller = await getUserFromToken(req);
  if (!caller) return res.status(401).json({ error: 'Non autorisé' });

  const { data: callerProfile } = await supabase
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle();

  if (callerProfile?.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé — admin uniquement' });
  }

  const { userId, role } = req.body;
  if (!userId || !['free', 'standard', 'premium', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'userId et role valides requis' });
  }

  const { error } = await supabase
    .from('users')
    .update({ role })
    .eq('id', userId);

  if (error) {
    console.error('update-role error:', error);
    return res.status(500).json({ error: error.message });
  }

  console.log(`Admin ${caller.email} → user ${userId} role = '${role}'`);
  res.json({ success: true });
});

// ── Stripe Checkout ──
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Paiement non configuré. Contacte le support.' });

  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { plan } = req.body;
  if (!['standard', 'premium'].includes(plan)) {
    return res.status(400).json({ error: 'Plan invalide' });
  }

  const plans = {
    standard: {
      name: 'Mirror Standard',
      description: 'Générations illimitées chaque jour',
      amount: 599, // 5,99 €
    },
    premium: {
      name: 'Mirror Premium',
      description: 'Générations illimitées + styles exclusifs',
      amount: 1099, // 10,99 €
    },
  };

  const chosen = plans[plan];
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { plan },
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: chosen.name,
            description: chosen.description,
          },
          unit_amount: chosen.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/?subscribed=${plan}`,
      cancel_url:  `${baseUrl}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Impossible de créer la session de paiement.' });
  }
});

// ── Profil utilisateur (role) ──
app.get('/api/me', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { data: profile } = await supabase
    .from('users')
    .select('role, genre')
    .eq('id', user.id)
    .maybeSingle();

  res.json({
    role:  profile?.role  || 'free',
    genre: profile?.genre || null,
  });
});

// ── Admin API ──
app.get('/api/admin/stats', async (req, res) => {
  // 1. Vérifier que l'utilisateur est admin
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Non autorisé' });

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé — admin uniquement' });
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    // Total utilisateurs
    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    // Utilisateurs actifs aujourd'hui (1 ligne par user par jour)
    const { count: activeToday } = await supabase
      .from('daily_usage')
      .select('*', { count: 'exact', head: true })
      .eq('date', today);

    // Tenues générées aujourd'hui
    const { data: usageToday } = await supabase
      .from('daily_usage')
      .select('count')
      .eq('date', today);
    const outfitsToday = (usageToday || []).reduce((s, r) => s + (r.count || 0), 0);

    // Tenues générées au total
    const { data: usageAll } = await supabase
      .from('daily_usage')
      .select('count');
    const outfitsTotal = (usageAll || []).reduce((s, r) => s + (r.count || 0), 0);

    // Répartition des rôles
    const { data: roleRows } = await supabase
      .from('users')
      .select('role');
    const roles = { free: 0, standard: 0, premium: 0, admin: 0 };
    (roleRows || []).forEach(u => {
      const r = u.role || 'free';
      roles[r] = (roles[r] || 0) + 1;
    });

    // 10 derniers inscrits
    const { data: lastUsers } = await supabase
      .from('users')
      .select('id, email, genre, role, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    res.json({
      totalUsers:  totalUsers  || 0,
      activeToday: activeToday || 0,
      outfitsToday,
      outfitsTotal,
      roles,
      lastUsers: lastUsers || [],
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération des stats.' });
  }
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stripe:    !!stripe,
    anthropic: !!anthropic,
    supabase:  !!supabase,
    uptime:    Math.floor(process.uptime()),
  });
});

// ── Pages ──
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'reset-password.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'mirror_v02.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mirror running on port ${PORT}`);

  // ── Keep-alive Supabase (évite la mise en pause après inactivité) ──
  if (supabase) {
    const INTERVAL_MS = 48 * 60 * 60 * 1000; // 48 heures

    const pingSupabase = async () => {
      try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) console.warn('Keep-alive Supabase warning:', error.message);
        else console.log('Keep-alive Supabase OK —', new Date().toISOString());
      } catch (e) {
        console.warn('Keep-alive Supabase error:', e.message);
      }
    };

    setInterval(pingSupabase, INTERVAL_MS);
    console.log('Keep-alive Supabase actif (ping toutes les 48h)');
  }
});
