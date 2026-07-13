// ── Mood-derived scale ────────────────────────────────────────
// Pure-data + pure-function module: no runtime audio state.
// Data tables, emotion lexicon, and deterministic helper functions.
// Each piece of text gets its OWN scale, chosen from its mood — not
// random, and not the same every time. Same text → same scale always,
// since it's derived from the text itself (word list + punctuation).
// All frequencies below are generated programmatically from semitone
// offsets, not typed by hand, so there is no chance of an accidental
// off-scale note sneaking in.

export const MODE_OFFSETS = {
  // ── very dark / unstable ──────────────────────────────────────
  diminished:       [0, 2, 3, 5, 6, 8, 9, 11], // max instability — unsettling, horror
  locrian:          [0, 1, 3, 5, 6, 8, 10],     // ominous, unresolved, falling
  doubleHarmonic:   [0, 1, 4, 5, 7, 8, 11],     // Byzantine/Arabic — exotic, alien
  phrygian:         [0, 1, 3, 5, 7, 8, 10],     // dark, tense, confrontational
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],     // flamenco — dramatic, fierce
  // ── dark / emotional ──────────────────────────────────────────
  harmonicMinor:    [0, 2, 3, 5, 7, 8, 11],     // dramatic, cinematic tension
  minor:            [0, 2, 3, 5, 7, 8, 10],     // Aeolian — heavy, melancholic
  pentMinor:        [0, 3, 5, 7, 10],            // raw, deep, minimal — like Burial
  // ── bittersweet / complex ─────────────────────────────────────
  dorian:           [0, 2, 3, 5, 7, 9, 10],     // dark but lifted, bittersweet
  melodicMinor:     [0, 2, 3, 5, 7, 9, 11],     // smooth, jazzy, wistful
  enigmatic:        [0, 1, 4, 6, 8, 10, 11],    // Verdi — rare, mysterious, alien
  wholeTone:        [0, 2, 4, 6, 8, 10],        // weightless, dreamlike, no gravity
  // ── bright / resolved ─────────────────────────────────────────
  mixolydian:       [0, 2, 4, 5, 7, 9, 10],     // bluesy, warm but unresolved
  lydian:           [0, 2, 4, 6, 7, 9, 11],     // floating, dreamy — very Aphex Twin
  pentMajor:        [0, 2, 4, 7, 9],            // open, folk-like, bright
  major:            [0, 2, 4, 5, 7, 9, 11],     // warm, resolved, clear
};

// 16 modes ordered darkest/most-unstable → brightest/most-resolved
// detectMood maps a continuous score onto this spectrum
export const MODE_ORDER = [
  'diminished','locrian','doubleHarmonic','phrygian','phrygianDominant',
  'harmonicMinor','minor','pentMinor',
  'dorian','melodicMinor','enigmatic','wholeTone',
  'mixolydian','lydian','pentMajor','major'
];

// A much larger emotion lexicon, grouped by category rather than just pos/neg —
// each category has its own pull on the mood score and on "tension" (instability),
// so the detector reads more like real sentiment than a simple word-counter.
export const EMOTION_LEXICON = {
  joy: { weight: 1.1, tense: 0, words: [
    'happy','joy','joyful','delight','delighted','glad','cheerful','elated','bliss','blissful',
    'wonderful','great','fantastic','amazing','laugh','laughing','smile','smiling','fun','playful',
    'excited','sunny','bright','radiant','vibrant','lively',
    'stoked','pumped','thrilled','buzzing','chuffed','hyped','giddy','tickled','ecstatic',
    'jazzed','psyched','jolly','merry','gleeful','giggling',
    'elated','jubilant','overjoyed','delighted','cheerful','cheery','bubbly','perky','spirited',
    'exuberant','radiating','glowing','beaming','grinning','laughing','chuckling','celebratory',
    'festive','playful','silly','goofy','carefree','lighthearted','blissful','euphoric',
    'on cloud nine','over the moon','walking on air','tickled pink','in high spirits',
    'all smiles','having a blast','jumping for joy','bursting with joy','infectious laughter',
    'feel-good','good vibes','positive energy',
    'شاد','خوشحال','شادمان','خنده','لبخند','سرخوش','بانمک','هیجان','شور','شعف','مسرور','سرزنده'
  ]},
  love: { weight: 1.0, tense: 0, words: [
    'love','loving','adore','affection','sweetheart','darling','cherish','beloved','romance',
    'kiss','embrace','tender','devotion','soulmate','warmth','caring',
    'crush','smitten','infatuated','babe','honey','boo','cuddle','snuggle','flirt','flirting',
    'romantic','valentine','mate','partner',
    'affectionate','devoted','cherish','cherished','treasure','treasured','darling','sweetheart',
    'beloved','dear','dearest','my love','love of my life','head over heels','butterflies',
    'swoon','swooning','enamored','besotted','adoring','hug','hugging','forever yours',
    'true love','soulmates','made for each other','hopeless romantic','love bug','puppy love',
    'first love','love at first sight','romance','romancing','wooing','courting',
    'sweet nothings','love letter',
    'عشق','دلبر','محبوب','دوست‌داشتن','عاشق','نازنین','دلتنگ','مهربان','صمیمی','محبت','دلداده'
  ]},
  calm: { weight: 0.7, tense: -0.3, words: [
    'calm','peace','peaceful','serene','quiet','still','gentle','soft','tranquil','rest','resting',
    'breathe','ease','relax','relaxed','soothing','silence','stillness',
    'chill','chilling','mellow','laid-back','easygoing','unwind','unwinding','relaxing',
    'cozy','comfy','breezy','low-key',
    'tranquil','tranquility','serenity','quietude','hush','hushed','gentle breeze','calm down',
    'take it easy','no worries','all good','at ease','at peace','meditative','meditate',
    'meditating','zen','centered','grounded','balanced','steady','composed','unruffled',
    'unbothered','unfazed','cool as a cucumber','deep breath','slow down','take a breather',
    'downtime','me time','quiet time','still waters','peace of mind','inner peace',
    'calm and collected',
    'آرام','آرامش','سکوت','ساکت','راحت','استراحت','نرم','ملایم','صلح','هدوء','سکون'
  ]},
  hope: { weight: 0.8, tense: -0.1, words: [
    'hope','hopeful','dream','dreaming','future','faith','believe','wish','light','promise',
    'grateful','gratitude','free','freedom','alive','beginning','new','grow','growth',
    'optimistic','upbeat','motivated','ambitious','driven','determined','striving','aspire',
    'aspiring','potential','opportunity','onward',
    'hopeful','encouraged','encouraging','promising','bright future','silver lining',
    'light at the end of the tunnel','never give up','keep going','believe in yourself',
    'dream big','reach for the stars','new beginnings','fresh start','second chance',
    'turning point','breakthrough','progress','moving forward','on the right track','trust the process',
    'better days ahead','brighter days','rise above','overcome','resilient','resilience',
    'perseverance','persistence','willpower','inspired','inspiring','uplifted','motivational',
    'hope springs eternal','keep the faith','stay strong',
    'امید','امیدوار','رویا','آینده','ایمان','آرزو','نور','شکرگزار','آزاد','زندگی','رشد','شروع'
  ]},
  sadness: { weight: -1.0, tense: 0.1, words: [
    'sad','sadness','sorrow','grief','grieving','cry','crying','tears','weep','heartbroken',
    'lonely','alone','loneliness','empty','emptiness','hollow','loss','lost','miss','missing',
    'hurt','hurting','broken','depressed','down','blue','gloom','gloomy','melancholy','heavy',
    'bummed','blah','miserable','wrecked','drained','worn out','exhausted','burnt out',
    'homesick','heartache','mourning','regret',
    'sorrowful','forlorn','dejected','despondent','desolate','woeful','tearful','weeping',
    'sobbing','crying','broken hearted','grief-stricken','grieving','in mourning','lonely',
    'isolated','abandoned','forsaken','hollow','numb inside',"can't stop crying",'feeling low',
    'feeling blue','down and out','at a loss','lost without you','missing you',
    'wish you were here','it hurts','hurts so much','aching heart','heavy heart',
    'weight on my chest','drowning in sadness','falling apart','breaking down',"can't cope",
    'overwhelmed with grief','teary eyed','choked up','sinking feeling','heartsick','lovesick',
    'غم','غمگین','اندوه','گریه','اشک','تنها','تنهایی','خالی','شکست','شکسته','از دست دادن',
    'دلتنگی','درد','افسرده','سنگین','ملال','اندوهگین'
  ]},
  fear: { weight: -0.9, tense: 0.5, words: [
    'fear','afraid','scared','terrified','terror','dread','anxious','anxiety','worry','worried',
    'nervous','panic','threat','danger','unsafe','trembling','frightened','horror','nightmare',
    'freaked','spooked','jumpy','paranoid','uneasy','jittery','on edge','rattled','shaken',
    'dreading','apprehensive','wary','spooky','creepy','unnerved',
    'terrified','petrified','horrified','alarmed','scared stiff','scared to death',
    'shaking with fear','cold sweat','heart racing',"can't breathe",'panic attack',
    'anxiety attack','fight or flight','worst case scenario','afraid of the dark','phobia',
    'phobic','dreadful','ominous','foreboding','sense of dread','walking on eggshells',
    'on high alert','hypervigilant','startled','spooked out','nerve wracking','unsettling',
    'disturbing','chilling','bone chilling','blood curdling','hair raising','jump scare',
    'imminent danger','close call','near miss','life or death','in over my head',
    'ترس','ترسیده','وحشت','نگران','نگرانی','اضطراب','استرس','خطر','کابوس','لرزان','هراس'
  ]},
  anger: { weight: -0.7, tense: 1.0, words: [
    'anger','angry','furious','fury','rage','enraged','mad','hate','hatred','resent','resentment',
    'bitter','bitterness','outrage','irritated','frustrated','frustration','scream','screaming',
    'fight','fighting','violent','violence','chaos','chaotic','explode','explosive',
    'fuck','fucking','fucked','shit','shitty','damn','dammit','hell','ass','asshole','bitch',
    'bastard','crap','screwed','pissed','ticked off','fed up','sick of','annoyed','annoying',
    'irritating','irritated','livid','seething','grumpy','cranky','snapped','mean','rude',
    'jerk','dumb','stupid','idiot','moron',
    'furious','enraged','infuriated','incensed','outraged','irate','wrathful',
    'boiling with rage','seeing red','blood boiling','lose my temper','lost my temper',
    'snap at','blow a fuse','hit the roof','fly off the handle','pissed off','ticked',
    'riled up','worked up','on the warpath','out for blood','holding a grudge','resentful',
    'bitter','bitterness','spiteful','vindictive','hostile','aggressive','confrontational',
    'argumentative','feud','grudge match','get lost','shut up','screw you','go to hell',
    'piss off','freaking annoying','drives me crazy','makes my blood boil','last straw',
    'final straw','had it up to here','fed up with','sick and tired','done with this',
    'enough is enough',
    'خشم','عصبانی','غضب','نفرت','کینه','خشمگین','عصبانیت','جنگ','هرج و مرج','وحشی','انفجار'
  ]},
  dark: { weight: -0.8, tense: 0.4, words: [
    'dark','darkness','cold','coldness','death','dying','dead','despair','desperate','hopeless',
    'void','abyss','shadow','shadows','bleak','doom','suffering','pain','painful','wound','wounded',
    'wasted','smashed','numb','burnt','crushed','empty inside','dead inside','rock bottom',
    'low','downward spiral',
    'despair','anguish','torment','tormented','tortured soul','haunted','haunting','ghostly',
    'eerie','sinister','macabre','morbid','grim','grimly','bleak outlook','bottomless pit',
    'spiraling down','self destructive','self-loathing','worthless','hopeless case',
    'giving up','given up',"can't go on",'breaking point','edge of the abyss',
    'consumed by darkness','lost soul','wandering soul','shattered dreams','crushed spirit',
    'weight of the world','drowning in darkness','end of the road','nothing left',
    'empty shell','hollow shell',
    'تاریک','تاریکی','سرد','سرما','مرگ','مردن','ناامید','نومیدی','رنج','درد','زخم','سایه','تباهی'
  ]},
  nostalgia: { weight: -0.2, tense: -0.1, words: [
    'remember','memory','memories','past','once','childhood','old','faded','distant',
    'longing','yearning','bittersweet','farewell','goodbye','gone','fading','nostalgia','nostalgic',
    'throwback','back in the day','good old days','reminisce','reminiscing','flashback',
    'those days','olden days','way back','used to',
    'wistful','sentimental','sentimentality','reminiscent','trip down memory lane',
    'those were the days','remember when','back when','in the good old days','golden days',
    'glory days','bygone era','bygone days','days gone by','simpler times',
    'childhood memories','school days','old friends','old times','walk down memory lane',
    'time flies','how time flies','miss those days','wish I could go back',
    'take me back','those were good times','feels like yesterday','seems like forever ago',
    'long time ago',
    'یاد','خاطره','خاطرات','گذشته','کودکی','دلتنگی','خداحافظ','رفته','محو','دور'
  ]},
  vice: { weight: -0.3, tense: 0.2, words: [
    'smoke','smoking','cigarette','cigarettes','cigs','vape','vaping','drunk','wasted','booze',
    'beer','alcohol','hangover','buzzed','stoned','high','weed','joint','shots','bar','pub',
    'party','hungover',
    'shot glass','hangover cure','blackout drunk','chain smoker','nicotine','nicotine fix',
    'smoke break','cigarette break','one more drink','last call','bottoms up','cheers',
    'getting wasted','getting drunk','night out','bar hopping','pub crawl','rolling a joint',
    'lighting up','puffing','taking a hit','buzzed feeling','tipsy','sloshed','hammered',
    'plastered','three sheets to the wind','hair of the dog','liquid courage','happy hour'
  ]},
  casual: { weight: 0, tense: 0, words: [
    'dude','bro','man','guy','buddy','pal','mate','yo','hey','sup','nah','yeah','yep','nope',
    'okay','fine','sure','cool','awesome','whatever','literally','basically','honestly',
    'actually','seriously','totally','kinda','sorta','gonna','wanna','gotta',
    'stuff','thing','things','guys','folks',
    'omg','lol','lmao','tbh','imo','fr','no cap','low key','high key','deadass','bet',
    'say less','on god','facts','vibes','mood','same','big mood','felt that','sending it',
    "that's crazy",'wild','nuts','bananas','sus','cringe','based','ratio','slaps',
    'hits different','no joke','for real','straight up','real talk','sorta kinda','ish',
    'whatevs','k','kk'
  ]},
  confusion: { weight: 0, tense: 0.3, words: [
    'confused','confusing','puzzled','puzzling','bewildered','baffled','perplexed','lost',
    "don't get it",'makes no sense','what the heck','huh','wait what',"i don't understand",
    'mixed up','all over the place','scratching my head','no idea','beats me','who knows',
    'unclear','ambiguous','ambivalent','torn','undecided','second guessing'
  ]},
  surprise: { weight: 0.4, tense: 0.5, words: [
    'surprised','shocked','stunned','astonished','amazed','astounded','taken aback',
    'caught off guard','out of nowhere',"didn't see that coming",'plot twist','no way',
    'wow','whoa','holy cow','oh my god','unbelievable',"can't believe it",'mind blown',
    'jaw dropped','speechless','flabbergasted','gobsmacked','blindsided','unexpected',
    'unforeseen','sudden twist','out of the blue','jaw-dropping'
  ]},
};

export function buildScale(rootHz, modeName) {
  const offsets = MODE_OFFSETS[modeName] || MODE_OFFSETS.minor;
  return offsets.map(o => rootHz * Math.pow(2, o / 12));
}

// Simple deterministic hash so the same text always maps to the same root —
// not random, but text-dependent (different text very likely picks a different root)
export function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

// Build a flat lookup once: word -> { weight, tense } for fast matching
export const WORD_LOOKUP = (() => {
  const map = {};
  Object.values(EMOTION_LEXICON).forEach(({ weight, tense, words }) => {
    words.forEach(w => { map[w] = { weight, tense }; });
  });
  return map;
})();

export function detectMood(text) {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-zA-Zا-ی]+/g) || [];
  let score = 0;
  let tense = 0;
  words.forEach(w => {
    const hit = WORD_LOOKUP[w];
    if (hit) { score += hit.weight; tense += hit.tense; }
  });
  const exclaim  = (text.match(/!/g) || []).length;
  const question = (text.match(/\?/g) || []).length;
  const ellipsis = (text.match(/\.\.\./g) || []).length;
  score += exclaim * 0.4;
  score -= question * 0.25;
  score -= ellipsis * 0.3;
  tense += exclaim * 0.5;

  const norm = score / Math.max(3, Math.sqrt(words.length));
  const tenseNorm = tense / Math.max(3, Math.sqrt(words.length));

  // map continuous score onto 16-mode spectrum
  const clamped = Math.max(-1.5, Math.min(1.5, norm));
  let idx = Math.round(((clamped + 1.5) / 3.0) * (MODE_ORDER.length - 1));

  // high tension → pull toward the exotic/unstable cluster (first 5 modes)
  if (tenseNorm > 0.5 && idx > 3) idx = Math.max(1, idx - 4);

  idx = Math.max(0, Math.min(MODE_ORDER.length - 1, idx));
  return { mode: MODE_ORDER[idx], normScore: norm, tenseScore: tenseNorm };
}

// Root candidates — two octave layers so dark moods can go lower, bright moods higher
export function noteFreq(semisFromA2) { return 110.00 * Math.pow(2, semisFromA2 / 12); }
// A1 through G#2 (low register) + A2 through G#3 (mid register) = 24 roots
export const ROOT_CANDIDATES_LOW  = Array.from({ length: 12 }, (_, i) => noteFreq(i - 12)); // A1–G#2
export const ROOT_CANDIDATES_MID  = Array.from({ length: 12 }, (_, i) => noteFreq(i));      // A2–G#3

// chord built from scale degrees 1-3-5 (and optionally 7) of the current scale — always in-key
  // degreeRoot: 0=i, 2=iii, 4=v, 6=vii (0-indexed into the 7-note scale array)
  const len = scale.length;
  const root = scale[degreeRoot % len] * (degreeRoot >= len ? 2 : 1);
  const third = scale[(degreeRoot + 2) % len] * ((degreeRoot + 2) >= len ? 2 : 1);
  const fifth = scale[(degreeRoot + 4) % len] * ((degreeRoot + 4) >= len ? 2 : 1);
  const seventh = scale[(degreeRoot + 6) % len] * ((degreeRoot + 6) >= len ? 2 : 1);
  return [root, third, fifth, seventh];
}

// chord built from scale degrees 1-3-5 (and optionally 7) of the current scale — always in-key
export function chordFromScale(scale, degreeRoot) {
  // degreeRoot: 0=i, 2=iii, 4=v, 6=vii (0-indexed into the 7-note scale array)
  const len = scale.length;
  const root = scale[degreeRoot % len] * (degreeRoot >= len ? 2 : 1);
  const third = scale[(degreeRoot + 2) % len] * ((degreeRoot + 2) >= len ? 2 : 1);
  const fifth = scale[(degreeRoot + 4) % len] * ((degreeRoot + 4) >= len ? 2 : 1);
  const seventh = scale[(degreeRoot + 6) % len] * ((degreeRoot + 6) >= len ? 2 : 1);
  return [root, third, fifth, seventh];
}
