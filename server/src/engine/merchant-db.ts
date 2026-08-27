// ---------------------------------------------------------------------------
// Merchant Knowledge Base — Smart recognition for US merchants
// ---------------------------------------------------------------------------
// Maps merchant names / bank-statement patterns → category.
// Covers the top ~1500+ US merchants, retailers, restaurants, service providers,
// and common bank-statement abbreviations.
//
// KEY DESIGN DECISIONS:
// 1. Entries are stored LOWERCASE for O(1) lookup via Set/Map.
// 2. We include common statement abbreviations (e.g. "wm supercenter" for Walmart).
// 3. More specific entries (e.g. "uber eats") must be checked BEFORE less specific
//    ones (e.g. "uber") — the categorizer handles this via longest-match-first.
// 4. Categories match the default FinBudget category names exactly.
// ---------------------------------------------------------------------------

export interface MerchantEntry {
  pattern: string;       // lowercase pattern to match against transaction name
  category: string;      // target category name
  confidence: number;    // 0.0–1.0 how confident we are
  subcategory?: string;  // optional finer classification
  /**
   * Beats the user's own auto-learned rules.
   *
   * Normally a user rule wins over the merchant database, and it should: a
   * deliberate correction is better evidence than a lookup table. But rules
   * are also learned automatically from whatever the engine guessed at the
   * time, so a rule can encode an answer the owner has since overruled — and
   * because rules run first, the correction silently does nothing.
   *
   * This has now happened twice. Interactive Brokers stayed booked as income
   * after being ruled an asset transfer, and $37,494 of roofing stayed filed
   * as a home improvement after being ruled capital, both because a stale
   * auto-learned rule outranked the corrected entry. Only entries that come
   * from an explicit owner decision carry this flag.
   */
  authoritative?: boolean;
}

/**
 * Patterns set by an explicit owner ruling. Checked before user rules.
 * Keep this list short and keep every entry traceable to a decision.
 */
export const AUTHORITATIVE_PATTERNS: string[] = [
  'interactive brok des:ach transf',  // 26 Aug 2026 — "an asset transfer, not income"
  'carvana',                          // 26 Aug 2026 — "a sale. proceeds, not income"
  'prosper market p',                 // 26 Aug 2026 — "that came from Prosper debt"
  'roofing',                          // 27 Aug 2026 — "the roof specifically ... a different category"
  't&s roofing',
  're-pipe',
  'repipe',
];

/** Is this entry one the owner has ruled on directly? */
export function isAuthoritative(entry: MerchantEntry): boolean {
  return AUTHORITATIVE_PATTERNS.includes(entry.pattern);
}

// ---------------------------------------------------------------------------
// GROCERY STORES & SUPERMARKETS
// ---------------------------------------------------------------------------
const GROCERIES: MerchantEntry[] = [
  // Major chains
  'whole foods', 'trader joe', 'kroger', 'safeway', 'albertsons',
  'publix', 'wegmans', 'h-e-b', 'heb', 'food lion', 'aldi',
  'lidl', 'meijer', 'winco', 'piggly wiggly', 'sprouts',
  'harris teeter', 'giant eagle', 'giant food', 'stop & shop',
  'stop and shop', 'shoprite', 'shop rite', 'food bazaar',
  'price chopper', 'market basket', 'bi-lo', 'bilo',
  'winn-dixie', 'winn dixie', 'food city', 'ingles',
  'hannaford', 'stater bros', 'ralphs', 'vons', 'jewel-osco',
  'jewel osco', 'acme markets', 'acme market', 'lucky supermarket',
  'save mart', 'savemart', 'food 4 less', 'food4less',
  'grocery outlet', 'fresh market', 'the fresh market',
  'fresh thyme', 'earth fare', 'natural grocers', 'fairway market',
  'key food', 'food emporium', 'gristedes', 'morton williams',
  'associated supermarket', 'bravo supermarket', 'compare foods',
  'food town', 'foodtown', 'pathmark', 'big y', 'tops market',
  'tops friendly', 'market 32', 'food maxx', 'foodmaxx',
  'commissary', 'deca', 'smart & final', 'smart and final',
  'restaurant depot', 'cash and carry', 'chef store',
  // Warehouse clubs (primarily grocery)
  'costco', 'sam\'s club', 'sams club', 'bj\'s wholesale', 'bjs wholesale',
  // Walmart grocery
  'walmart grocery', 'wm supercenter', 'wal-mart', 'wal mart',
  'walmart supercenter', 'walmart neighborhood',
  // Specialty grocery
  'asian market', 'asian grocery', 'ranch 99', '99 ranch',
  'h mart', 'hmart', 'mitsuwa', 'uwajimaya',
  'patel brothers', 'india bazaar', 'sedano', 'fiesta mart',
  'northgate market', 'cardenas market', 'el super',
  'vallarta supermarket', 'la michoacana', 'food co-op',
  // Online grocery
  'instacart', 'shipt', 'freshdirect', 'fresh direct',
  'peapod', 'amazon fresh', 'amazonfresh', 'hungryroot',
  'thrive market', 'thrivemarket', 'misfit', 'misfits market',
  'imperfect foods', 'butcher box', 'butcherbox', 'omaha steaks',
  // Generic
  'grocery', 'supermarket', 'produce', 'farmers market',
].map(p => ({ pattern: p, category: 'Groceries', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// FOOD & DINING — Restaurants, Fast Food, Delivery, Coffee
// ---------------------------------------------------------------------------
const FOOD_DINING: MerchantEntry[] = [
  // Fast food / QSR
  'mcdonald', 'mcdonalds', 'burger king', 'wendy', 'wendys',
  'taco bell', 'chick-fil-a', 'chickfila', 'chik-fil-a',
  'popeyes', 'popeye', 'kfc', 'kentucky fried',
  'sonic drive', 'jack in the box', 'jack box',
  'whataburger', 'white castle', 'rally', 'checkers',
  'carl\'s jr', 'carls jr', 'hardee', 'arby', 'arbys',
  'del taco', 'taco cabana', 'taco bueno', 'el pollo loco',
  'culver', 'culvers', 'zaxby', 'raising cane', 'canes',
  'wingstop', 'buffalo wild wings', 'bww',
  'bojangles', 'church\'s chicken', 'churchs chicken',
  'long john silver', 'captain d', 'cook out', 'cookout',
  'dairy queen', 'dq grill', 'a&w', 'krystal',
  'steak n shake', 'steak \'n shake', 'rally\'s',
  // Fast casual
  'chipotle', 'panera', 'five guys', 'shake shack',
  'in-n-out', 'in n out', 'innout', 'sweetgreen',
  'cava', 'noodles & company', 'noodles and company',
  'jason\'s deli', 'jasons deli', 'mcalister', 'mcalisters',
  'firehouse subs', 'jersey mike', 'jersey mikes', 'jimmy john',
  'jimmy johns', 'which wich', 'potbelly', 'quiznos',
  'blaze pizza', 'mod pizza', 'pieology', 'pie five',
  'waba grill', 'el pollo', 'baja fresh', 'qdoba',
  'moe\'s southwest', 'moes southwest', 'rubio\'s', 'rubios',
  'tropical smoothie', 'smoothie king', 'jamba', 'jamba juice',
  'robeks', 'pressed juicery',
  // Pizza
  'domino', 'dominos', 'pizza hut', 'papa john', 'papa johns',
  'little caesars', 'little caesar', 'papa murphy', 'papa murphys',
  'round table pizza', 'marcos pizza', 'hungry howie',
  'jets pizza', 'cicis pizza', 'cici\'s',
  // Casual dining
  'olive garden', 'applebee', 'applebees', 'chili\'s', 'chilis',
  'outback steakhouse', 'outback steak', 'red lobster',
  'longhorn steakhouse', 'longhorn steak', 'texas roadhouse',
  'cracker barrel', 'denny', 'dennys', 'ihop', 'waffle house',
  'bob evans', 'perkins', 'village inn', 'golden corral',
  'ruby tuesday', 'tgi friday', 'tgif', 'cheesecake factory',
  'p.f. chang', 'pf chang', 'pf changs', 'benihana',
  'red robin', 'buffalo wild', 'hooters', 'twin peaks',
  'bonefish grill', 'carrabba', 'carrabbas',
  'seasons 52', 'yard house', 'bahama breeze',
  'cheddar\'s scratch', 'cheddars', 'first watch',
  'another broken egg', 'brunch', 'breakfast',
  // Coffee & bakery
  'starbucks', 'dunkin', 'dunkin donuts', 'peet\'s coffee',
  'peets coffee', 'caribou coffee', 'tim hortons', 'panera bread',
  'dutch bros', 'scooter\'s coffee', 'scooters coffee',
  'coffee bean', 'community coffee', 'philz coffee',
  'blue bottle', 'intelligentsia', 'la colombe',
  'krispy kreme', 'insomnia cookie', 'crumbl',
  'nothing bundt', 'cinnabon', 'auntie anne',
  // Delivery apps
  'doordash', 'door dash', 'grubhub', 'grub hub',
  'uber eats', 'ubereats', 'postmates', 'caviar',
  'seamless', 'eat24', 'delivery.com', 'slice',
  'gopuff', 'favor delivery', 'waitr',
  // Ice cream & desserts
  'baskin robbins', 'baskin-robbins', 'cold stone',
  'marble slab', 'haagen-dazs', 'haagen dazs',
  'ben & jerry', 'ben and jerry', 'dippin dots',
  'maggie moo', 'carvel', 'rita\'s italian', 'ritas ice',
  'froyo', 'yogurtland', 'menchie', 'pinkberry',
  'tcby', 'sweet frog', 'orange leaf',
  // Generic dining
  'restaurant', 'cafe', 'diner', 'bistro', 'grill',
  'tavern', 'eatery', 'kitchen', 'bakery', 'pizzeria',
  'steakhouse', 'sushi', 'ramen', 'thai food', 'chinese food',
  'indian food', 'mexican food', 'pho', 'boba', 'bubble tea',
  'food truck', 'catering', 'buffet',
].map(p => ({ pattern: p, category: 'Food & Dining', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// SHOPPING — Retail, Department Stores, Online
// ---------------------------------------------------------------------------
const SHOPPING: MerchantEntry[] = [
  // Big-box / department
  'target', 'walmart', 'amazon', 'amazon.com', 'amzn',
  'amzn mktp', 'amazon marketplace', 'amazon prime',
  'best buy', 'bestbuy', 'home depot', 'homedepot',
  'lowes', 'lowe\'s', 'ikea', 'bed bath', 'bed bath & beyond',
  'pier 1', 'crate & barrel', 'crate and barrel',
  'pottery barn', 'williams-sonoma', 'williams sonoma',
  'west elm', 'restoration hardware', 'rh ', 'cb2',
  'world market', 'cost plus',
  // Department stores
  'nordstrom', 'macys', 'macy\'s', 'bloomingdales',
  'bloomingdale', 'neiman marcus', 'saks fifth',
  'saks off', 'jcpenney', 'jc penney', 'penney',
  'kohl', 'kohls', 'kohl\'s', 'dillard', 'dillards',
  'belk', 'von maur', 'lord & taylor',
  // Discount / off-price
  'tj maxx', 'tjmaxx', 'tjx', 'marshalls', 'marshall',
  'ross', 'ross dress', 'burlington', 'burlington coat',
  'nordstrom rack', 'off saks', 'sierra trading',
  'homegoods', 'home goods', 'five below',
  'dollar general', 'dollar tree', 'family dollar',
  'big lots', '99 cents', 'ollie\'s', 'ollies',
  // Electronics & tech
  'apple store', 'apple.com', 'microsoft store',
  'samsung', 'b&h photo', 'bh photo', 'micro center',
  'microcenter', 'newegg', 'fry\'s electronics', 'frys',
  'gamestop', 'game stop',
  // Fashion & apparel
  'nike', 'adidas', 'under armour', 'lululemon',
  'gap', 'old navy', 'banana republic', 'j.crew', 'j crew',
  'h&m', 'zara', 'forever 21', 'asos', 'shein',
  'uniqlo', 'express', 'abercrombie', 'american eagle',
  'aeropostale', 'anthropologie', 'free people',
  'urban outfitters', 'hot topic', 'torrid',
  'lane bryant', 'talbots', 'ann taylor', 'loft',
  'chico\'s', 'chicos', 'white house black market',
  'brooks brothers', 'men\'s wearhouse', 'mens wearhouse',
  'jos a bank', 'stitch fix', 'stitchfix', 'rent the runway',
  'poshmark', 'thredup', 'thrift',
  // Shoes
  'foot locker', 'footlocker', 'finish line',
  'dsw', 'famous footwear', 'shoe carnival',
  'zappos', 'aldo', 'steve madden', 'clarks',
  // Home improvement & hardware
  'ace hardware', 'true value', 'menards',
  'harbor freight', 'tractor supply', 'northern tool',
  'fastenal', 'grainger',
  // Craft & hobby
  'michaels', 'joann', 'jo-ann', 'hobby lobby',
  'blick art', 'dick blick',
  // Sporting goods
  'dick\'s sporting', 'dicks sporting', 'academy sports',
  'bass pro', 'cabela', 'rei ', 'rei co-op',
  // Books & media
  'barnes & noble', 'barnes and noble', 'half price books',
  'bookstore', 'book store',
  // Online marketplaces
  'etsy', 'ebay', 'wish.com', 'wish ', 'aliexpress',
  'wayfair', 'overstock', 'zulily',
  'chegg', 'thriftbooks', 'mercari', 'offerup',
  // Auto parts
  'autozone', 'auto zone', 'advance auto', 'o\'reilly auto',
  'oreilly auto', 'napa auto', 'pep boys',
  // Office & school
  'office depot', 'staples', 'office max', 'officemax',
  // Generic
  'shop', 'store', 'mall', 'outlet', 'marketplace',
].map(p => ({ pattern: p, category: 'Shopping', confidence: 0.75 }));

// ---------------------------------------------------------------------------
// TRANSPORTATION — Gas, Rideshare, Auto, Transit, Tolls
// ---------------------------------------------------------------------------
const TRANSPORTATION: MerchantEntry[] = [
  // Gas stations & convenience stores
  'shell', 'chevron', 'exxon', 'exxonmobil', 'bp ',
  'sunoco', 'marathon', 'valero', 'citgo', 'phillips 66',
  'conoco', 'conocophillips', 'arco', 'speedway',
  'circle k', 'quiktrip', 'qt ', 'wawa', 'sheetz',
  'racetrac', 'raceway', 'murphy usa', 'murphy oil',
  '7-eleven', '7 eleven', '7-11', 'seven eleven', 'seven-eleven',
  'casey\'s', 'caseys', 'casey general', 'kwik trip', 'kwiktrip',
  'pilot flying j', 'pilot travel', 'flying j', 'loves travel',
  'love\'s travel', 'ta travel', 'petro stopping',
  'cumberland farms', 'cumby', 'kum & go', 'kum and go',
  'maverick', 'mapco', 'thorntons', 'royal farms', 'rofo',
  'quick check', 'quickchek', 'plaid pantry', 'ampm', 'am pm',
  'buc-ee', 'bucee', 'sinclair', 'holiday station',
  'gate petroleum', 'getgo', 'get go', 'turkey hill',
  // Generic fuel
  'gas', 'fuel', 'petrol', 'diesel',
  // Rideshare
  'uber', 'lyft', 'via ride',
  // Auto services
  'jiffy lube', 'valvoline', 'meineke', 'midas',
  'firestone', 'goodyear', 'discount tire', 'les schwab',
  'big o tire', 'ntb ', 'national tire', 'pep boys',
  'maaco', 'safelite', 'caliber collision',
  'car wash', 'carwash', 'mister car wash',
  // Parking & tolls
  'parking', 'parkwhiz', 'spothero', 'park mobile',
  'parkmobile', 'meter', 'toll', 'e-zpass', 'ezpass',
  'fastrak', 'sunpass', 'pikepass', 'ipass',
  'transponder', 'turnpike',
  // Public transit
  'metro', 'transit', 'mta', 'bart', 'cta',
  'wmata', 'septa', 'marta', 'trimet',
  'clipper', 'metrocard', 'orca card',
  'bus pass', 'rail pass', 'subway',
  // Car payments & registration
  'car payment', 'auto loan', 'dmv', 'registration',
  'emission', 'smog check',
].map(p => ({ pattern: p, category: 'Transportation', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// SUBSCRIPTIONS — Streaming, Software, Memberships
// ---------------------------------------------------------------------------
const SUBSCRIPTIONS: MerchantEntry[] = [
  // Video streaming
  'netflix', 'hulu', 'disney+', 'disney plus', 'disneyplus',
  'hbo max', 'hbo ', 'max.com', 'amazon prime video',
  'prime video', 'paramount+', 'paramount plus',
  'peacock', 'apple tv', 'appletv', 'discovery+',
  'discovery plus', 'espn+', 'espn plus', 'fubo',
  'fubotv', 'sling tv', 'slingtv', 'youtube tv',
  'youtubetv', 'crunchyroll', 'funimation', 'mubi',
  'criterion', 'shudder', 'britbox', 'acorn tv',
  'curiosity stream', 'tubi',
  // Music streaming
  'spotify', 'apple music', 'youtube music',
  'youtube premium', 'amazon music', 'pandora',
  'tidal', 'deezer', 'sirius', 'siriusxm',
  // Audio & reading
  'audible', 'kindle unlimited', 'scribd',
  'blinkist', 'medium.com', 'substack',
  'nytimes', 'ny times', 'new york times',
  'washington post', 'wsj', 'wall street journal',
  'the athletic', 'reuters', 'bloomberg',
  // Cloud storage
  'icloud', 'google one', 'google storage',
  'dropbox', 'onedrive', 'box.com',
  // Software
  'adobe', 'creative cloud', 'microsoft 365',
  'microsoft office', 'office 365', 'zoom',
  'slack', 'notion', 'evernote', 'todoist',
  'lastpass', '1password', 'bitwarden', 'nordvpn',
  'expressvpn', 'surfshark', 'dashlane',
  'grammarly', 'canva', 'figma',
  // Gaming subscriptions
  'xbox game pass', 'gamepass', 'ps plus', 'psplus',
  'playstation plus', 'nintendo online',
  'ea play', 'ubisoft+',
  // Fitness subscriptions
  'peloton', 'strava', 'fitbit premium',
  'apple fitness', 'beachbody', 'daily burn',
  'headspace', 'calm', 'noom',
  // Memberships
  'amazon prime', 'costco membership', 'sam\'s club member',
  'aaa membership', 'aaa ', 'bj\'s membership',
  // Other
  'patreon', 'twitch', 'onlyfans',
  'chatgpt', 'openai', 'claude', 'anthropic',
  'github', 'gitlab', 'heroku',
].map(p => ({ pattern: p, category: 'Subscriptions', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// UTILITIES — Phone, Internet, Electric, Water, Gas
// ---------------------------------------------------------------------------
const UTILITIES: MerchantEntry[] = [
  // Wireless / mobile
  'at&t', 'att ', 'verizon', 't-mobile', 'tmobile',
  'sprint', 'us cellular', 'cricket wireless', 'cricket ',
  'metro by t-mobile', 'metropcs', 'boost mobile',
  'mint mobile', 'visible', 'google fi', 'fi.google',
  'ting', 'republic wireless', 'straight talk',
  'total wireless', 'tracfone', 'consumer cellular',
  // Internet & cable
  'comcast', 'xfinity', 'spectrum', 'cox comm',
  'centurylink', 'lumen', 'frontier comm', 'frontier fiber',
  'windstream', 'mediacom', 'optimum', 'altice',
  'astound', 'wow internet', 'consolidated comm',
  'google fiber', 'sonic.net', 'rcn ',
  'directv', 'dish network', 'hughesnet', 'starlink',
  'viasat', 't-mobile home', 'tmobile internet',
  // Electric & gas utility
  'pg&e', 'pacific gas', 'southern california edison',
  'sce ', 'sdg&e', 'con edison', 'coned', 'con ed',
  'duke energy', 'dominion energy', 'southern company',
  'florida power', 'fpl ', 'entergy',
  'xcel energy', 'ameren', 'alliant energy',
  'consumers energy', 'dte energy', 'eversource',
  'national grid', 'ppl electric', 'pseg',
  'centerpoint', 'atmos energy', 'nicor gas',
  'washington gas', 'laclede gas', 'spire energy',
  'peoples gas', 'south union gas',
  // Water & sewer
  'water utility', 'water dept', 'water district',
  'sewer', 'wastewater', 'stormwater',
  // Trash & recycling
  'waste management', 'republic services', 'waste connections',
  'recology', 'trash', 'garbage', 'recycling',
  // Generic
  'electric', 'gas bill', 'utility', 'utilities',
  'internet', 'phone bill', 'cable bill', 'broadband',
].map(p => ({ pattern: p, category: 'Utilities', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// HEALTHCARE — Medical, Dental, Pharmacy, Vision
// ---------------------------------------------------------------------------
const HEALTHCARE: MerchantEntry[] = [
  // Pharmacies
  'cvs', 'walgreens', 'rite aid', 'riteaid',
  'duane reade', 'kinney drug', 'bartell drug',
  // Hospitals & medical
  'hospital', 'medical center', 'health system',
  'kaiser', 'kaiser permanente', 'hca healthcare',
  'mayo clinic', 'cleveland clinic', 'mount sinai',
  'cedars-sinai', 'johns hopkins', 'mass general',
  'memorial sloan', 'md anderson', 'quest diagnostic',
  'quest diag', 'labcorp', 'lab corp',
  'planned parenthood', 'minute clinic', 'minuteclinic',
  // Insurance payments
  'united health', 'unitedhealth', 'uhc ', 'anthem',
  'blue cross', 'blue shield', 'bcbs', 'aetna',
  'cigna', 'humana', 'kaiser perm', 'molina',
  'centene', 'wellcare', 'ambetter', 'oscar health',
  // Vision
  'lenscrafters', 'pearle vision', 'americas best',
  'warby parker', 'eyemart', 'visionworks',
  'optometrist', 'ophthalmol', 'eye doctor', 'eye care',
  // Dental
  'dental', 'dentist', 'orthodont', 'oral surg',
  'aspen dental', 'heartland dental', 'pacific dental',
  // Mental health
  'therapist', 'counselor', 'psycholog', 'psychiatr',
  'betterhelp', 'talkspace', 'cerebral',
  // Generic
  'doctor', 'physician', 'clinic', 'urgent care',
  'emergency room', 'pharmacy', 'prescription',
  'medical', 'healthcare', 'health care', 'copay',
].map(p => ({ pattern: p, category: 'Healthcare', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// HEALTH & FITNESS — Gyms, Sports, Wellness
// ---------------------------------------------------------------------------
const HEALTH_FITNESS: MerchantEntry[] = [
  'planet fitness', 'la fitness', 'equinox', 'lifetime fitness',
  'life time fitness', 'anytime fitness', 'gold\'s gym', 'golds gym',
  '24 hour fitness', '24hour fitness', 'crunch fitness', 'crunch gym',
  'orangetheory', 'orange theory', 'f45 training', 'f45 ',
  'crossfit', 'ymca', 'ywca', 'barre3', 'pure barre',
  'soulcycle', 'soul cycle', 'barry\'s bootcamp', 'barrys',
  'corepower yoga', 'yoga', 'pilates', 'martial art',
  'boxing', 'climbing gym', 'rock climbing',
  'gnc ', 'vitamin shoppe', 'bodybuilding.com',
  'myprotein', 'athletic greens',
  'gym', 'fitness', 'sport club', 'recreation center',
].map(p => ({ pattern: p, category: 'Health & Fitness', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// INSURANCE — Auto, Home, Life, Health
// ---------------------------------------------------------------------------
const INSURANCE: MerchantEntry[] = [
  'geico', 'progressive', 'allstate', 'state farm',
  'liberty mutual', 'farmers insurance', 'nationwide',
  'usaa', 'erie insurance', 'american family',
  'travelers', 'hartford', 'safeco', 'esurance',
  'root insurance', 'lemonade', 'metlife',
  'prudential', 'new york life', 'northwestern mutual',
  'lincoln financial', 'principal financial',
  'aflac', 'colonial penn', 'globe life',
  'shelter insurance', 'auto-owners',
  'insurance', 'premium', 'policy',
].map(p => ({ pattern: p, category: 'Insurance', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// HOUSING — Rent, Mortgage, Property
// ---------------------------------------------------------------------------
const HOUSING: MerchantEntry[] = [
  'rent', 'mortgage', 'hoa', 'homeowner', 'condo fee',
  'property tax', 'property mgmt', 'property management',
  'apartment', 'lease', 'landlord', 'tenant',
  'zillow', 'zelle rent', 'venmo rent',
  'avalonbay', 'equity residential', 'greystar',
  'camden property', 'essex property', 'udr ',
  'mid-america', 'invitation homes', 'american homes',
  'airbnb', 'vrbo',
  // Mortgage companies
  'rocket mortgage', 'quicken loans', 'united wholesale',
  'pennymac', 'loandepot', 'loan depot', 'mr. cooper',
  'mr cooper', 'freedom mortgage', 'caliber home',
  'guild mortgage', 'movement mortgage', 'fairway mortgage',
  'wells fargo home', 'chase mortgage', 'bank of america mort',
  'nationstar', 'newrez', 'shellpoint',
].map(p => ({ pattern: p, category: 'Housing', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// TRAVEL — Airlines, Hotels, Car Rental, Booking
// ---------------------------------------------------------------------------
const TRAVEL: MerchantEntry[] = [
  // Airlines
  'american airlines', 'delta air', 'united airlines',
  'southwest air', 'jetblue', 'jet blue', 'alaska air',
  'spirit air', 'frontier air', 'allegiant',
  'hawaiian air', 'sun country', 'breeze airways',
  'avelo', 'airline',
  // Hotels
  'marriott', 'hilton', 'hyatt', 'ihg ', 'intercontinental',
  'holiday inn', 'hampton inn', 'courtyard by marriott',
  'fairfield inn', 'residence inn', 'springhill suites',
  'westin', 'sheraton', 'w hotel', 'st. regis',
  'ritz-carlton', 'ritz carlton', 'four seasons',
  'waldorf', 'doubletree', 'embassy suites',
  'homewood suites', 'home2 suites', 'garden inn',
  'la quinta', 'wyndham', 'radisson', 'best western',
  'choice hotels', 'comfort inn', 'quality inn',
  'days inn', 'super 8', 'motel 6', 'red roof',
  'extended stay', 'drury', 'omni hotel',
  'loews hotel', 'kimpton', 'ace hotel',
  // Car rental
  'hertz', 'enterprise rent', 'national car',
  'avis', 'budget rent', 'dollar rent', 'thrifty',
  'alamo rent', 'sixt ', 'zipcar', 'turo',
  // Booking platforms
  'booking.com', 'expedia', 'hotels.com', 'priceline',
  'kayak', 'orbitz', 'hotwire', 'trivago',
  'travelocity', 'tripadvisor', 'airbnb', 'vrbo',
  'hostelworld',
  // Cruises
  'carnival cruise', 'royal caribbean', 'norwegian cruise',
  'princess cruise', 'celebrity cruise', 'msc cruise',
  'disney cruise',
  // Generic
  'hotel', 'motel', 'resort', 'flight', 'travel',
  'vacation', 'cruise', 'luggage', 'tsa precheck',
  'global entry', 'passport',
].map(p => ({ pattern: p, category: 'Travel', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// ENTERTAINMENT — Movies, Games, Events, Recreation
// ---------------------------------------------------------------------------
const ENTERTAINMENT: MerchantEntry[] = [
  // Movie theaters
  'amc theatre', 'amc theater', 'regal cinema', 'regal theatre',
  'cinemark', 'cineplex', 'landmark theatre', 'alamo drafthouse',
  'marcus theatre', 'imax', 'movie tavern', 'studio movie',
  // Live events
  'ticketmaster', 'live nation', 'livenation',
  'stubhub', 'seatgeek', 'vivid seats', 'axs ',
  'eventbrite', 'fandango',
  // Theme parks
  'six flags', 'cedar point', 'universal studios',
  'disneyland', 'disney world', 'seaworld', 'sea world',
  'busch gardens', 'legoland', 'knott\'s berry', 'knotts',
  'hersheypark', 'dollywood',
  // Gaming
  'steam', 'valve', 'playstation', 'psn ', 'ps store',
  'xbox', 'microsoft xbox', 'nintendo', 'epic games',
  'riot games', 'blizzard', 'activision', 'roblox',
  'twitch', 'discord nitro',
  // Recreation
  'bowling', 'dave & buster', 'dave and buster',
  'top golf', 'topgolf', 'main event', 'chuck e cheese',
  'round1', 'round 1', 'arcade', 'laser tag',
  'trampoline', 'sky zone', 'escape room',
  'mini golf', 'putt putt', 'go kart', 'gokart',
  'paintball', 'axe throwing',
  // Museums, zoos, aquariums
  'museum', 'zoo ', 'aquarium', 'botanical garden',
  'planetarium', 'science center', 'art gallery',
  // Sports
  'golf course', 'country club', 'tennis',
  'ski resort', 'ski pass', 'lift ticket',
  'batting cage', 'driving range',
  // Generic
  'entertainment', 'amusement', 'concert', 'show',
  'theater', 'theatre', 'cinema', 'festival',
].map(p => ({ pattern: p, category: 'Entertainment', confidence: 0.80 }));

// ---------------------------------------------------------------------------
// EDUCATION — Schools, Courses, Tutoring
// ---------------------------------------------------------------------------
const EDUCATION: MerchantEntry[] = [
  'university', 'college', 'school', 'tuition',
  'student loan', 'navient', 'sallie mae', 'nelnet',
  'great lakes', 'mohela', 'fedloan', 'aidvantage',
  'udemy', 'coursera', 'skillshare', 'masterclass',
  'linkedin learning', 'pluralsight', 'codecademy',
  'khan academy', 'brilliant.org', 'duolingo',
  'rosetta stone', 'babbel', 'chegg', 'quizlet',
  'kaplan', 'princeton review', 'sylvan', 'kumon',
  'mathnasium', 'tutor', 'textbook', 'pearson',
  'mcgraw-hill', 'mcgraw hill', 'cengage', 'wiley',
  'scholastic', 'college board', 'act test', 'sat prep',
  'gre prep', 'gmat prep', 'lsat prep',
  'education', 'academic', 'seminar', 'workshop',
  'continuing ed', 'certification',
].map(p => ({ pattern: p, category: 'Education', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// PERSONAL CARE — Salon, Barber, Beauty, Spa
// ---------------------------------------------------------------------------
const PERSONAL_CARE: MerchantEntry[] = [
  'sephora', 'ulta', 'ulta beauty', 'mac cosmetics',
  'bath & body works', 'bath and body', 'the body shop',
  'lush ', 'sally beauty', 'supercuts', 'great clips',
  'sport clips', 'fantastic sams', 'cost cutters',
  'floyd\'s 99', 'floyds', 'birds barbershop',
  'drybar', 'blowout', 'nail salon', 'nail spa',
  'waxing', 'european wax', 'laser hair',
  'dermatolog', 'skin care', 'skincare',
  'tanning', 'sun tan', 'massage envy', 'hand & stone',
  'hand and stone', 'elements massage',
  'salon', 'barber', 'spa', 'beauty', 'cosmetic',
  'haircut', 'hair salon', 'manicure', 'pedicure',
].map(p => ({ pattern: p, category: 'Personal Care', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// PETS — Supplies, Vet, Grooming
// ---------------------------------------------------------------------------
const PETS: MerchantEntry[] = [
  'petsmart', 'petco', 'pet supplies plus', 'pet supermarket',
  'chewy', 'chewy.com', 'barkbox', 'bark box',
  'rover.com', 'rover ', 'wag ', 'wag.com',
  'vet', 'veterinary', 'veterinarian', 'animal hospital',
  'animal clinic', 'banfield', 'vca animal', 'bluepearl',
  'pet grooming', 'doggy daycare', 'dog daycare',
  'boarding', 'kennel', 'pet food', 'dog food', 'cat food',
  'petland', 'pet valu', 'healthy pet',
].map(p => ({ pattern: p, category: 'Pets', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// GIFTS & DONATIONS — Charity, Gifts, Flowers
// ---------------------------------------------------------------------------
const GIFTS: MerchantEntry[] = [
  'hallmark', '1-800-flowers', '1800flowers', 'ftd ',
  'proflowers', 'teleflora', 'edible arrangement',
  'gift card', 'giftcard', 'gift shop',
  'red cross', 'salvation army', 'goodwill',
  'habitat for humanity', 'united way', 'march of dimes',
  'st. jude', 'st jude', 'unicef', 'world vision',
  'feeding america', 'toys for tots', 'make-a-wish',
  'sierra club', 'wwf ', 'aspca', 'humane society',
  'gofundme', 'go fund me',
  'donation', 'charity', 'charitable', 'tithe', 'offering',
  'church', 'temple', 'mosque', 'synagogue',
  'gift', 'flowers', 'florist', 'greeting card',
].map(p => ({ pattern: p, category: 'Gifts & Donations', confidence: 0.80 }));

// ---------------------------------------------------------------------------
// INVESTMENTS — Brokerages, Crypto, Retirement
// ---------------------------------------------------------------------------
const INVESTMENTS: MerchantEntry[] = [
  'vanguard', 'fidelity', 'schwab', 'charles schwab',
  'etrade', 'e-trade', 'e*trade', 'td ameritrade',
  'robinhood', 'webull', 'sofi invest', 'acorns',
  'stash', 'm1 finance', 'public.com', 'firstrade',
  'interactive brokers', 'tastytrade', 'tastyworks',
  'wealthfront', 'betterment', 'personal capital',
  'empower', 'ellevest', 'fundrise',
  'merrill lynch', 'merrill edge', 'morgan stanley',
  'goldman sachs', 'jp morgan', 'jpmorgan',
  'ubs ', 'credit suisse', 'raymond james',
  'edward jones', 'ameriprise', 'lpl financial',
  'coinbase', 'binance', 'kraken', 'gemini',
  'crypto.com', 'blockchain', 'bitcoin', 'ethereum',
  'investment', 'brokerage', '401k', '401(k)', 'ira ',
  'roth ira', 'stock', 'mutual fund',
].map(p => ({ pattern: p, category: 'Investments', confidence: 0.85 }));

// ---------------------------------------------------------------------------
// INCOME — Payroll, Deposits, Freelance platforms
// ---------------------------------------------------------------------------
const INCOME: MerchantEntry[] = [
  // Payroll providers (these appear on deposits)
  'adp ', 'adp payroll', 'paychex', 'gusto',
  'workday', 'ceridian', 'dayforce', 'paylocity',
  'paycom', 'rippling', 'justworks', 'trinet',
  'namely', 'bamboohr', 'zenefits',
  // Freelance / gig platforms
  'upwork', 'fiverr', 'toptal', 'freelancer.com',
  // Payment platforms (incoming)
  'paypal transfer', 'venmo cashout', 'zelle from',
  'cash app from', 'square deposit', 'stripe transfer',
  // Government
  'irs treas', 'tax refund', 'treasury', 'ssa treas',
  'social security', 'ssi ', 'ssdi ',
  'unemployment', 'edd ', 'state benefit',
  // Generic
  'salary', 'payroll', 'direct deposit', 'direct dep',
  'paycheck', 'wage', 'freelance', 'consulting fee',
  'interest', 'dividend', 'refund', 'reimbursement',
  'bonus', 'commission', 'royalt', 'rental income',
].map(p => ({ pattern: p, category: 'Income', confidence: 0.80 }));

// ---------------------------------------------------------------------------
// TRANSFER — Between own accounts, P2P, wire transfers
// ---------------------------------------------------------------------------
// NOTE: Zelle, Venmo, PayPal and Cash App are NOT here. They are payment
// rails, not destinations — this household receives most of its income and
// pays most of its contractors over Zelle. Filing the rail as a transfer hid
// $220k of income and $20k of spending. What a P2P payment means is decided by
// who is on the other end, which is a rule, not a keyword.
//
// Bank fees are not transfers either; they are a real cost and belong in
// interest_fee so they show up in spending.
const TRANSFER: MerchantEntry[] = [
  'transfer', 'xfer', 'wire ',
  'overdraft protection',
  'atm withdrawal', 'atm deposit',
  'cash withdrawal', 'cash deposit',
].map(p => ({ pattern: p, category: 'Transfer', confidence: 0.75 }));

const BANK_FEES: MerchantEntry[] = [
  'overdraft item fee', 'nsf fee', 'returned item fee',
  'bank fee', 'service charge', 'monthly fee',
  'maintenance fee', 'account fee', 'international transaction fee',
].map(p => ({ pattern: p, category: 'Bank Fees', confidence: 0.80 }));

// ---------------------------------------------------------------------------
// REAL BANK DESCRIPTORS
// ---------------------------------------------------------------------------
// The rest of this file is merchant *brands*. These are the ACH and bill-pay
// descriptors US banks actually emit, which look nothing like a storefront
// name and were the largest single source of miscategorisation: mortgage
// servicers, lenders, lease companies, 529 plans and payroll originators all
// arrived as unrecognised text and fell through to whatever generic keyword
// happened to collide with them.
//
// High confidence because these are exact descriptor stems, not brand guesses.
const US_BANK_DESCRIPTORS: MerchantEntry[] = [
  // Mortgage servicers — kept out of "Housing" so debt service is visible
  ['citizens des:mtg', 'Mortgage'], ['citizens home loans', 'Mortgage'],
  ['third federal', 'Mortgage'], ['thfsla', 'Mortgage'],
  ['mr. cooper', 'Mortgage'], ['rocket mortgage', 'Mortgage'],
  ['wells fargo home mtg', 'Mortgage'], ['freedom mortgage', 'Mortgage'],
  ['des:mtg pmt', 'Mortgage'], ['home loans bill payment', 'Mortgage'],

  // Vehicle leases and finance
  ['des:auto lease', 'Auto Lease'], ['stellantis', 'Auto Lease'],
  ['infiniti', 'Auto Lease'], ['nissan motor accept', 'Auto Lease'],
  ['toyota financial', 'Auto Lease'], ['honda financial', 'Auto Lease'],
  ['ally auto', 'Auto Lease'], ['des:lease pmt', 'Auto Lease'],

  // Consumer lenders. Repayments and drawdowns are opposite events and must
  // not share a category: the drawdown raises cash and debt together, so
  // counting it as income hides the borrowing entirely.
  ['prosper marketpl', 'Loan Payment'],
  ['prosper market p', 'Loan Proceeds'], ['space coast credit union loans', 'Loan Payment'],
  ['lending club', 'Loan Payment'], ['sofi lending', 'Loan Payment'],
  ['upstart network', 'Loan Payment'], ['best egg', 'Loan Payment'],

  // College savings — set aside, not spent
  ['vgi 529', 'College Savings'], ['529 ach', 'College Savings'],
  ['collegeadvantage', 'College Savings'], ['my529', 'College Savings'],
  ['bright start', 'College Savings'], ['scholarshare', 'College Savings'],

  // Kids — allowance cards and youth sports
  ['greenlight', 'Kids'], ['gohenry', 'Kids'], ['famzoo', 'Kids'],
  ['jfi*strikers', 'Kids'], ['jfi*fc prime', 'Kids'],
  ['elite basketball', 'Kids'], ['miami breakers', 'Kids'],
  ['us soccer 5', 'Kids'],

  // Recurring home services, as distinct from capital improvements
  ['pool service', 'Home Services'], ['poolserv', 'Home Services'],
  ['alligator pool', 'Home Services'], ['terminix', 'Home Services'],
  ['exterminating', 'Home Services'], ['lawn service', 'Home Services'],
  ['pest control', 'Home Services'],

  // Structural work on the house is capital, not a home-improvement habit.
  // The T&S Roofing payments are $37,494 across three months; filed under
  // Home Improvements they landed in the discretionary tier, which reads as
  // "you could stop buying roofs".
  ['roofing', 'Capital Improvements'], ['t&s roofing', 'Capital Improvements'],
  ['re-pipe', 'Capital Improvements'], ['repipe', 'Capital Improvements'],
  ['bill.com', 'Home Improvements'],

  // Taxes and government
  ['us treasury irs', 'Taxes'], ['irs des:usataxpymt', 'Taxes'],
  ['dept of revenue', 'Taxes'], ['franchise tax', 'Taxes'],
  ['property appraiser', 'Taxes'], ['tax collector', 'Taxes'],

  // Utilities that arrive as bill-pay descriptors
  ['florida power & light', 'Utilities'], ['florida power and light', 'Utilities'],
  ['comed', 'Utilities'], ['des:m-dwasdpmt', 'Utilities'],
  ['miami-dade water', 'Utilities'], ['att des:payment', 'Utilities'],

  // Payroll and business income originators
  ['des:payroll', 'Salary'], ['des:direct dep', 'Salary'],
  ['fifth generation', 'Salary'],
  // Brokerage withdrawals to checking. Matched on the full ACH descriptor so
  // it cannot catch a cheque written INTO the brokerage, which is a deposit
  // going the other way.
  //
  // Owner's ruling (26 Aug 2026): "The money from IB is an asset transfer, not
  // income." Moving money out of his own brokerage account does not make the
  // household any richer — it converts one asset into another. Booking it as
  // income overstated earnings by $39,200 over 18 months.
  ['interactive brok des:ach transf', 'Asset Transfer'],

  // Insurance premiums paid by ACH
  ['northwestern mu', 'Insurance'], ['des:isa pyment', 'Insurance'],

  // Selling an asset converts one thing you own into another. It is not
  // earnings, and folding it into income overstates what the household makes.
  ['carvana', 'Asset Sale'], ['carmax', 'Asset Sale'], ['vroom', 'Asset Sale'],
].map(([pattern, category]) => ({ pattern, category, confidence: 0.92 }));

// ---------------------------------------------------------------------------
// CC PMT — Credit card payments
// ---------------------------------------------------------------------------
// Real bank descriptors, not idealised ones. Bank of America writes
// "CITIBANK CREDIT CARD Bill Payment" and "Online Banking payment to CRD 7533";
// none of the old entries ("card payment", "cc pmt") matched either, which is
// why every card payment fell through to Transfer.
//
// Bare 'autopay' and 'auto pay' are gone: they matched utilities and insurance
// on autopay and quietly removed them from spending.
const CC_PMT: MerchantEntry[] = [
  'credit card payment', 'credit card bill payment',
  'cc payment', 'cc pmt', 'crd pmt',
  'payment to crd', 'payment to card',
  'minimum payment', 'payment thank you', 'online payment thank',
  'balance payment', 'statement payment',
  'american express bill payment', 'american express des:ach pmt',
  'citibank credit card bill payment', 'citi card payment',
  'discover e-payment', 'discover des:e-payment',
  'synchrony bank payment', 'barclaycard payment',
  'capital one des:cardpymt', 'chase credit crd',
].map(p => ({ pattern: p, category: 'CC PMT', confidence: 0.80 }));

// ---------------------------------------------------------------------------
// Combine all entries into a single searchable array
// ---------------------------------------------------------------------------
export const MERCHANT_DATABASE: MerchantEntry[] = [
  ...GROCERIES,
  ...FOOD_DINING,
  ...SHOPPING,
  ...TRANSPORTATION,
  ...SUBSCRIPTIONS,
  ...UTILITIES,
  ...HEALTHCARE,
  ...HEALTH_FITNESS,
  ...INSURANCE,
  ...HOUSING,
  ...TRAVEL,
  ...ENTERTAINMENT,
  ...EDUCATION,
  ...PERSONAL_CARE,
  ...PETS,
  ...GIFTS,
  ...INVESTMENTS,
  ...INCOME,
  ...CC_PMT,
  ...TRANSFER,
  ...BANK_FEES,
  ...US_BANK_DESCRIPTORS,
];

// ---------------------------------------------------------------------------
// Build optimized lookup structures
// ---------------------------------------------------------------------------

// Sorted by pattern length (longest first) for specificity — "uber eats" before "uber"
// Confidence first, then length. Sorting by length alone let a long generic
// pattern outrank a short exact one — 'greenlight' (the kids' card) losing to
// whatever longer brand string happened to collide. Exact bank descriptors
// carry 0.92 and now win outright; generic words like 'grocery' and 'store'
// sit lowest and only apply when nothing specific matched.
const SORTED_MERCHANTS = [...MERCHANT_DATABASE].sort(
  (a, b) => (b.confidence - a.confidence) || (b.pattern.length - a.pattern.length)
);

/**
 * Look up a transaction name against the merchant knowledge base.
 * Returns the best (longest / most specific) match, or null.
 */
// Common POS / payment processor prefixes that appear on bank statements.
// Stripping these reveals the actual merchant name underneath.
const POS_PREFIXES = [
  'sq *', 'sq*', 'sqc*', 'sqi*',             // Square
  'tst*', 'tst ',                              // Toast (restaurant POS)
  'sp ', 'sp *', 'sp*',                        // Shopify
  'pos ', 'pos debit ',                         // Generic POS
  'purchase ', 'purchase authorized on ',       // Generic purchase
  'checkcard ', 'chkcard ',                     // Debit card
  'visa ', 'visa debit ',                       // Visa
  'mc ', 'mastercard ',                         // Mastercard
  'debit card purchase ',                       // Generic debit
  'recurring payment ',                         // Recurring
  'pre-auth ', 'preauth ',                      // Pre-authorization
  'ach ', 'ach debit ',                         // ACH
  'dd ', 'dd*',                                 // DoorDash merchant prefix
  'grubhub+ ', 'gh+ ',                         // Grubhub merchant prefix
  'pp*', 'pp *', 'paypal *', 'paypal*',        // PayPal
  'goo*', 'google *',                           // Google
  'appl*', 'apple.com/bill',                    // Apple
  'amzn mktp us*', 'amzn mktp ',               // Amazon Marketplace
  'zelle ',                                     // Zelle
  'venmo *', 'venmo*',                          // Venmo merchants
  'cko*',                                       // Checkout.com
];

/**
 * Patterns must match whole words, not substrings.
 *
 * Plain `.includes()` matched 'ach' inside "PUBLIX ... MIAMI BEACH FL",
 * "COACH OUTLET" and "THE PEACH COBBLER"; 'spa' inside "SPACE COAST CREDIT
 * UNION"; 'ira' inside "CACHOEIRA"; 'ssi' inside "HAMILTON'S CONCESSION".
 * Every one of those was filed under the wrong category, and the short
 * patterns did the most damage because they collide with the most words.
 *
 * A boundary is only added where the pattern's own edge is a word character,
 * so entries that deliberately carry punctuation or a trailing space —
 * 'amzn mktp ', 'goo*', 'apple.com/bill' — keep working unchanged.
 */
const BOUNDARY_CACHE = new Map<string, RegExp>();

function patternRegex(pattern: string): RegExp {
  let re = BOUNDARY_CACHE.get(pattern);
  if (re) return re;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openBoundary = /^\w/.test(pattern) ? '\\b' : '';
  const closeBoundary = /\w$/.test(pattern) ? '\\b' : '';
  re = new RegExp(openBoundary + escaped + closeBoundary, 'i');
  BOUNDARY_CACHE.set(pattern, re);
  return re;
}

/**
 * Look up ONLY the owner-ruled patterns. Used by the categoriser before it
 * consults the user's rules, so a ruling cannot be silently overridden by a
 * rule learned before the ruling existed.
 */
export function lookupAuthoritativeMerchant(transactionName: string): MerchantEntry | null {
  const m = lookupMerchant(transactionName);
  return m && isAuthoritative(m) ? m : null;
}

export function lookupMerchant(transactionName: string): MerchantEntry | null {
  const lower = transactionName.toLowerCase().trim();

  // Try matching directly first
  for (const entry of SORTED_MERCHANTS) {
    if (patternRegex(entry.pattern).test(lower)) {
      return entry;
    }
  }

  // Strip POS prefixes and try again
  let stripped = lower;
  for (const prefix of POS_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length).trim();
      break;
    }
  }

  if (stripped !== lower && stripped.length >= 3) {
    for (const entry of SORTED_MERCHANTS) {
      if (patternRegex(entry.pattern).test(stripped)) {
        return entry;
      }
    }
  }

  return null;
}

/**
 * Get stats about the merchant database.
 */
export function getMerchantDbStats(): {
  totalEntries: number;
  byCategory: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  for (const entry of MERCHANT_DATABASE) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
  }
  return { totalEntries: MERCHANT_DATABASE.length, byCategory };
}
