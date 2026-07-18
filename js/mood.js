// ── Mood-derived scale ────────────────────────────────────────
import { FA_LEXICON, FA_LEXICON_EXTRA } from './lexicon-fa.js';
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
                'شاد','خوشحال','شادمان','خنده','لبخند','سرخوش','بانمک','هیجان','شور','شعف','مسرور','سرزنده',
    'خوشی','شادی','خوشبخت','خوشبختی','سرحال','بشاش','خندان','خوش','خرم','دلشاد','ذوق',
    'کیف','حال','حالخوب','خوشوقت','مفرح','لذت','لذت‌بخش','دلپذیر','نشاط','بانشاط','قند‌توی‌دلم',
    'ذوق‌مرگ','پرانرژی','سرزندگی','خوشحالی','لبخندزنان','قهقهه','بخند','خوشگذرونی','عشق‌وحال'
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
    'عشق','دلبر','محبوب','دوست‌داشتن','عاشق','نازنین','دلتنگ','مهربان','صمیمی','محبت','دلداده',
    'عزیز','عزیزم','جانم','دلم','دلبند','معشوق','معشوقه','یار','دلدار','دلربا','عاشقانه',
    'دوستت‌دارم','دوستدارم','بوسه','بوس','آغوش','در‌آغوش','نوازش','دلبستگی','شیفته','والا',
    'وفا','باوفا','مهر','مهرورزی','عشقم','نفسم','دلبرم','یارم','جیگرم','ماه‌من'
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
    'آرام','آرامش','سکوت','ساکت','راحت','استراحت','نرم','ملایم','صلح','هدوء','سکون',
    'آسوده','آسودگی','بی‌خیال','بیخیال','قرار','باقرار','دل‌آرام','تسکین','آرامبخش','خونسرد',
    'خونسردی','آروم','آرومش','سرحوصله','حوصله','فراغت','دنج','آرامش‌بخش','متعادل','باطمأنینه',
    'طمأنینه','بی‌دغدغه','فارغ','آسایش','صبور','صبر','متین','ملایمت','آهسته'
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
    'امید','امیدوار','رویا','آینده','ایمان','آرزو','نور','شکرگزار','آزاد','زندگی','رشد','شروع',
    'امیدواری','آرزومند','رؤیا','رویاها','باور','اعتماد','پیشرفت','ترقی','موفقیت','پیروزی',
    'روشنایی','روشن','تابان','انگیزه','باانگیزه','مصمم','عزم','پشتکار','تلاش','کوشش','تازه',
    'نوین','فرصت','امکان','بهبود','بهتر‌شدن','جوانه','شکوفایی','دلگرم','دلگرمی','امیدبخش',
    'الهام','الهام‌بخش','سرافراز','سربلند','نویدبخش','آتیه','چراغ‌امید','آرمان'
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
    'دلتنگی','درد','افسرده','سنگین','ملال','اندوهگین',
    'ناراحت','ناراحتی','غصه','غصه‌دار','دلگیر','دل‌گرفته','بغض','بغض‌کرده','زار','زاری',
    'محزون','حزن','حزین','دل‌شکسته','دلشکسته','مغموم','پکر','دمغ','بی‌حوصله','بی‌حال',
    'خسته','خستگی','کلافه','دل‌مرده','افسردگی','یأس','مأیوس','دلمرده','گریان','اشکبار',
    'سوگ','سوگوار','ماتم','دل‌تنگ','غم‌انگیز','غمزده','ناامیدی','بی‌کسی','رنجور','آه','افسوس',
    'دلگرفته','دل‌گرفته','گرفته','دلمرده','گرفتگی','دل‌مرده','بغض‌آلود','چشم‌تر','اشک‌ریزان',
    'دل‌خون','دلخون','جگرسوخته','غم‌بار','غمبار','سیه‌روز','بیچاره','فلک‌زده','دل‌آزرده','آزرده'
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
    'ترس','ترسیده','وحشت','نگران','نگرانی','اضطراب','استرس','خطر','کابوس','لرزان','هراس',
    'ترسناک','وحشتناک','هراسان','مضطرب','دلشوره','دل‌شوره','دلهره','واهمه','بیم','بیمناک',
    'هول','هول‌شده','دلواپس','دلواپسی','پریشان','پریشانی','آشفته','آشفتگی','لرز','لرزیدن',
    'ترسو','بترس','می‌ترسم','میترسم','رعب','مرعوب','سراسیمه','دستپاچه','عرق‌سرد','تشویش',
    'نگرانم','خوف','مخوف','هولناک','بیمناکی','دلهره‌آور'
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
    'خشم','عصبانی','غضب','نفرت','کینه','خشمگین','عصبانیت','جنگ','هرج و مرج','وحشی','انفجار',
    'خشمناک','غضبناک','برافروخته','آتشی','آتشی‌مزاج','دعوا','دعوا‌کردن','داد','فریاد','عربده',
    'کفری','قاطی','عصبی','برزخ','کلافه','حرص','حرصی','لج','لجباز','بیزار','بیزاری','منزجر',
    'انزجار','تنفر','متنفر','عق','چندش','زشت','بی‌شعور','احمق','بی‌عقل','خفه‌شو','گمشو','برو‌گمشو',
    'لعنت','لعنتی','آشغال','عوضی','نامرد','دیوانه','خون‌خونمو‌میخوره','از‌کوره‌در‌رفتم','جوش‌آوردم'
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
    'تاریک','تاریکی','سرد','سرما','مرگ','مردن','ناامید','نومیدی','رنج','درد','زخم','سایه','تباهی',
    'ظلمت','ظلمانی','سیاه','سیاهی','مرده','جنازه','گور','قبر','عزا','یأس','مأیوس','پوچ','پوچی',
    'بیهوده','بی‌معنا','عذاب','شکنجه','زجر','زجرآور','دردناک','جانکاه','فلاکت','بدبخت','بدبختی',
    'نابودی','نابود','ویرانی','ویران','خرابه','متلاشی','خون','خونین','جهنم','مصیبت','فاجعه',
    'تلخ','تلخی','سیاه‌بختی','بن‌بست','ته‌خط','بریده','از‌پا‌افتاده','له‌شده','خرد‌شده'
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
    'یاد','خاطره','خاطرات','گذشته','کودکی','دلتنگی','خداحافظ','رفته','محو','دور',
    'یادش‌بخیر','قدیم','قدیما','قدیمی','بچگی','نوجوانی','دوران','آن‌روزها','اون‌روزا',
    'دلتنگ','یادآوری','یادگار','نوستالژی','نوستالژیک','حسرت','حسرت‌بار','دیرین','دیرینه',
    'کهنه','فراموش','فراموش‌نشدنی','بازگشت','برگرد','کاش‌برگرده','خاطره‌انگیز','مرور‌خاطرات',
    'زمان','گذر‌زمان','سال‌ها‌پیش','روزگار','روزگار‌قدیم','یادهای‌دور'
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
    'unclear','ambiguous','ambivalent','torn','undecided','second guessing',
    'گیج','گیجی','گیج‌شدم','سردرگم','سردرگمی','منگ','هاج‌وواج','متعجب','نمی‌فهمم','نمیفهمم',
    'چی','چیه','یعنی‌چی','چطور','مبهم','ابهام','دودل','دودلی','مردد','بلاتکلیف','سردرنمیارم',
    'قاطی‌کردم','گنگ','مات','مبهوت'
  ]},
  surprise: { weight: 0.4, tense: 0.5, words: [
    'surprised','shocked','stunned','astonished','amazed','astounded','taken aback',
    'caught off guard','out of nowhere',"didn't see that coming",'plot twist','no way',
    'wow','whoa','holy cow','oh my god','unbelievable',"can't believe it",'mind blown',
    'jaw dropped','speechless','flabbergasted','gobsmacked','blindsided','unexpected',
    'unforeseen','sudden twist','out of the blue','jaw-dropping',
    'تعجب','متعجب','شگفت','شگفت‌زده','شگفت‌انگیز','بهت','بهت‌زده','مبهوت','حیرت','حیرت‌زده',
    'واو','وای','عجب','عجیب','باورنکردنی','باورم‌نمیشه','نه‌بابا','جدی','جدی؟','چه‌جالب',
    'غافلگیر','غافلگیری','یهو','ناگهان','ناگهانی','یکهو','خشکم‌زد','ماتم‌برد','جاخوردم'
  ]},
};

// ── Merge the extended Persian lexicon into EMOTION_LEXICON ────
// The Persian words live in a separate file (lexicon-fa.js) to keep this
// module lean. They are appended to the matching category's `words` array
// here — BEFORE WORD_LOOKUP is built — so they inherit that category's
// weight/tense and are picked up automatically by every downstream helper.
// De-duplicated so a word already present isn't counted twice.
(function mergePersianLexicon() {
  const sources = [FA_LEXICON, FA_LEXICON_EXTRA];
  for (const src of sources) {
    for (const category in src) {
      if (!EMOTION_LEXICON[category]) continue; // skip unknown categories defensively
      const existing = new Set(EMOTION_LEXICON[category].words);
      for (const word of src[category]) {
        if (!existing.has(word)) {
          EMOTION_LEXICON[category].words.push(word);
          existing.add(word);
        }
      }
    }
  }
})();

// ── Context-aware modifiers (EN + FA) ─────────────────────────
// Negators flip the polarity of the emotion words that follow them within a
// short scope; intensifiers/diminishers scale their magnitude. This is what
// lets the detector understand "not happy", "خیلی غمگین", "کمی ناراحت" etc.
// instead of blindly summing isolated word weights.

// Words that INVERT the sentiment of the following few words.
export const NEGATORS = new Set([
  // English
  'not','no','never','none','nobody','nothing','nowhere','neither','nor',
  'without','cannot',"can't",'cant',"don't",'dont',"doesn't",'doesnt',
  "didn't",'didnt',"won't",'wont',"wouldn't",'wouldnt',"isn't",'isnt',
  "aren't",'arent',"wasn't",'wasnt',"weren't",'werent',"haven't",'havent',
  "hasn't",'hasnt',"shouldn't",'shouldnt',"couldn't",'couldnt',"ain't",'aint',
  'hardly','barely','scarcely','rarely','seldom',
  // Persian
  'نه','نیست','نبود','نیستم','نبودم','نداره','ندارم','نداشت','هیچ','هیچی',
  'هیچوقت','هرگز','بدون','نمی','نمیشه','نمیشد','نکن','نکردم','بی',
]);

// Multipliers applied to the magnitude of the following emotion word.
export const INTENSIFIERS = {
  // English — amplify
  'very': 1.6, 'so': 1.5, 'extremely': 2.0, 'incredibly': 1.9, 'really': 1.5,
  'super': 1.7, 'totally': 1.6, 'absolutely': 1.8, 'completely': 1.7,
  'utterly': 1.9, 'deeply': 1.7, 'terribly': 1.8, 'insanely': 1.9,
  'ridiculously': 1.8, 'unbelievably': 1.9, 'immensely': 1.8, 'profoundly': 1.8,
  'awfully': 1.7, 'exceptionally': 1.8, 'remarkably': 1.6, 'seriously': 1.5,
  'freaking': 1.7, 'hella': 1.7, 'mega': 1.7, 'way': 1.4,
  'too': 1.4, 'such': 1.4, 'most': 1.5, 'quite': 1.3, 'pretty': 1.25,
  // English — diminish
  'slightly': 0.5, 'somewhat': 0.6, 'kinda': 0.6, 'kind of': 0.6,
  'sorta': 0.6, 'a bit': 0.6, 'a little': 0.55, 'little': 0.6, 'mildly': 0.55,
  'faintly': 0.5, 'moderately': 0.7, 'fairly': 0.75,
  // Persian — amplify
  'خیلی': 1.7, 'بسیار': 1.7, 'خیلی‌خیلی': 2.0, 'واقعا': 1.5, 'واقعاً': 1.5,
  'حسابی': 1.6, 'بشدت': 1.9, 'شدیدا': 1.9, 'شدیداً': 1.9, 'کاملا': 1.7,
  'کاملاً': 1.7, 'فوق‌العاده': 1.9, 'بی‌نهایت': 2.0, 'خیلیخیلی': 2.0,
  // Persian — diminish
  'کمی': 0.55, 'کم': 0.6, 'یکم': 0.55, 'یه‌کم': 0.55, 'یکمی': 0.55,
  'تاحدی': 0.65, 'نسبتا': 0.7, 'نسبتاً': 0.7, 'اندکی': 0.5,
};

// ── Phrase layer (EN + FA) ────────────────────────────────────
// Multi-word expressions whose meaning is NOT the sum of their words. Two kinds:
//   • intensify:N  → multiply/boost the sentence's DOMINANT emotion by N
//     (e.g. "to death" after "love" → love ×; after "scared" → fear ×).
//     These carry no polarity of their own — they amplify whatever the piece
//     already feels, so "I love you to death" is *more* loving, not dark.
//   • weight/tense → a fixed emotional contribution (e.g. "madly in love").
// Phrases are matched on the normalized text BEFORE word-by-word analysis, so a
// word like "death" inside "love you to death" is consumed by the phrase and
// never counted as its own dark word.
export const PHRASES = [
  // ── pure intensifiers of the dominant emotion (EN) ──
  { p: 'to death', intensify: 1.9 },
  { p: 'to bits', intensify: 1.6 },
  { p: 'to pieces', intensify: 1.6 },
  { p: 'to the moon and back', intensify: 2.0 },
  { p: 'more than anything', intensify: 1.9 },
  { p: 'more than words', intensify: 1.9 },
  { p: 'beyond words', intensify: 1.9 },
  { p: 'beyond belief', intensify: 1.8 },
  { p: 'beyond measure', intensify: 1.9 },
  { p: 'with all my heart', intensify: 1.9 },
  { p: 'from the bottom of my heart', intensify: 1.9 },
  { p: 'more and more', intensify: 1.5 },
  { p: 'so much', intensify: 1.6 },
  { p: 'so so much', intensify: 1.9 },
  { p: 'like crazy', intensify: 1.8 },
  { p: 'like mad', intensify: 1.8 },
  { p: 'like never before', intensify: 1.7 },
  { p: 'once and for all', intensify: 1.5 },
  { p: 'head over heels', intensify: 1.9 },
  { p: 'with every fiber', intensify: 1.9 },
  { p: 'to the core', intensify: 1.7 },
  { p: 'out of my mind', intensify: 1.7 },
  { p: 'beyond repair', intensify: 1.7 },
  { p: 'for good', intensify: 1.3 },
  { p: 'for ever', intensify: 1.5 },
  { p: 'for eternity', intensify: 1.8 },
  { p: 'till the end', intensify: 1.7 },
  { p: 'until the end', intensify: 1.7 },
  { p: 'no matter what', intensify: 1.6 },

  // ── phrases with their OWN strong emotion (EN) ──
  { p: 'madly in love', weight: 1.9, tense: 0 },
  { p: 'deeply in love', weight: 1.9, tense: 0 },
  { p: 'head over heels in love', weight: 2.0, tense: 0 },
  { p: 'falling in love', weight: 1.5, tense: 0.1 },
  { p: 'love of my life', weight: 2.0, tense: 0 },
  { p: 'i love you', weight: 1.4, tense: 0 },
  { p: 'i adore you', weight: 1.6, tense: 0 },
  { p: 'miss you so much', weight: -0.6, tense: 0.2 },   // longing: bittersweet
  { p: 'miss you', weight: -0.4, tense: 0.15 },
  { p: 'scared to death', weight: -1.4, tense: 1.0 },
  { p: 'frightened to death', weight: -1.4, tense: 1.0 },
  { p: 'worried sick', weight: -1.1, tense: 0.8 },
  { p: 'sick to my stomach', weight: -1.1, tense: 0.7 },
  { p: 'on top of the world', weight: 1.8, tense: 0 },
  { p: 'over the moon', weight: 1.8, tense: 0 },
  { p: 'walking on air', weight: 1.7, tense: 0 },
  { p: 'on cloud nine', weight: 1.8, tense: 0 },
  { p: 'break my heart', weight: -1.5, tense: 0.4 },
  { p: 'broke my heart', weight: -1.5, tense: 0.4 },
  { p: 'broken heart', weight: -1.4, tense: 0.3 },
  { p: 'heart broke', weight: -1.4, tense: 0.4 },
  { p: 'tears in my eyes', weight: -1.0, tense: 0.2 },
  { p: 'lost my mind', weight: -0.8, tense: 0.9 },
  { p: 'losing my mind', weight: -0.8, tense: 0.9 },
  { p: 'fed up', weight: -0.8, tense: 0.7 },
  { p: 'sick and tired', weight: -0.9, tense: 0.6 },
  { p: 'can not take it anymore', weight: -1.2, tense: 0.9 },
  { p: 'cannot take it anymore', weight: -1.2, tense: 0.9 },
  { p: 'the end of the world', weight: -1.3, tense: 0.6 },
  { p: 'light of my life', weight: 1.7, tense: 0 },
  { p: 'gave up', weight: -1.0, tense: 0.3 },
  { p: 'giving up', weight: -1.0, tense: 0.4 },
  { p: 'let down', weight: -0.8, tense: 0.3 },
  { p: 'at peace', weight: 0.8, tense: -0.4 },
  { p: 'at ease', weight: 0.7, tense: -0.4 },
  { p: 'a long time ago', weight: -0.2, tense: -0.1, nostalgia: true },
  { p: 'those days', weight: -0.2, tense: 0, nostalgia: true },
  { p: 'the good old days', weight: 0.2, tense: -0.1, nostalgia: true },
  { p: 'back then', weight: -0.2, tense: 0, nostalgia: true },
  { p: 'used to be', weight: -0.2, tense: 0, nostalgia: true },
  { p: 'once upon a time', weight: 0, tense: 0, nostalgia: true },

  // ── pure intensifiers (FA) ──
  { p: 'تا حد مرگ', intensify: 1.9 },
  { p: 'تا سر حد مرگ', intensify: 1.9 },
  { p: 'تا پای مرگ', intensify: 1.9 },
  { p: 'با تمام وجود', intensify: 1.9 },
  { p: 'با تمام وجودم', intensify: 1.9 },
  { p: 'از ته دل', intensify: 1.8 },
  { p: 'از صمیم قلب', intensify: 1.9 },
  { p: 'بیش از حد', intensify: 1.6 },
  { p: 'بیش از اندازه', intensify: 1.7 },
  { p: 'بیشتر از هر چیزی', intensify: 1.9 },
  { p: 'بیشتر از همه چیز', intensify: 1.9 },
  { p: 'تا ابد', intensify: 1.7 },
  { p: 'برای همیشه', intensify: 1.6 },
  { p: 'خیلی خیلی', intensify: 1.9 },
  { p: 'بی نهایت', intensify: 2.0 },
  { p: 'به شدت', intensify: 1.8 },
  { p: 'حسابی', intensify: 1.5 },
  { p: 'دیوانه وار', intensify: 1.9 },
  { p: 'مثل دیوونه', intensify: 1.8 },
  { p: 'هر چقدر', intensify: 1.4 },

  // ── phrases with their OWN emotion (FA) ──
  { p: 'عاشقتم', weight: 1.6, tense: 0 },
  { p: 'دوستت دارم', weight: 1.4, tense: 0 },
  { p: 'عاشقانه دوستت دارم', weight: 2.0, tense: 0 },
  { p: 'دیوانه وار عاشقتم', weight: 2.0, tense: 0 },
  { p: 'دلم برات تنگ شده', weight: -0.5, tense: 0.2 },
  { p: 'دلتنگتم', weight: -0.5, tense: 0.2 },
  { p: 'دلم گرفته', weight: -1.0, tense: 0.2 },
  { p: 'دلم شکست', weight: -1.5, tense: 0.4 },
  { p: 'قلبم شکست', weight: -1.5, tense: 0.4 },
  { p: 'دل شکسته', weight: -1.4, tense: 0.3 },
  { p: 'اشک تو چشمام', weight: -1.0, tense: 0.2 },
  { p: 'از ترس مردم', weight: -1.4, tense: 1.0 },
  { p: 'ترسیدم تا حد مرگ', weight: -1.4, tense: 1.0 },
  { p: 'دیگه نمیتونم', weight: -1.2, tense: 0.9 },
  { p: 'دیگه طاقت ندارم', weight: -1.2, tense: 0.9 },
  { p: 'خسته شدم', weight: -0.9, tense: 0.5 },
  { p: 'ته دنیا', weight: -1.2, tense: 0.6 },
  { p: 'رو ابرا', weight: 1.7, tense: 0 },
  { p: 'دنیا مال منه', weight: 1.8, tense: 0 },
  { p: 'خوشحال ترین آدم', weight: 1.9, tense: 0 },
  { p: 'یاد گذشته', weight: -0.2, tense: 0, nostalgia: true },
  { p: 'اون روزا', weight: -0.2, tense: 0, nostalgia: true },
  { p: 'روزای قدیم', weight: 0.1, tense: -0.1, nostalgia: true },
  { p: 'زمان قدیم', weight: 0.1, tense: -0.1, nostalgia: true },
  { p: 'یه زمانی', weight: -0.1, tense: 0, nostalgia: true },
];

// Sort phrases longest-first so we match the most specific expression before its
// shorter substrings (e.g. "head over heels in love" before "head over heels").
const PHRASES_SORTED = [...PHRASES].sort((a, b) => b.p.length - a.p.length);

// How many following words a negator/intensifier reaches over.
const MODIFIER_SCOPE = 3;

// Build a flat lookup once: word -> { weight, tense } for fast matching.
// Defined here (before the helpers that read it) so there's no
// temporal-dead-zone fragility.
export const WORD_LOOKUP = (() => {
  const map = {};
  Object.values(EMOTION_LEXICON).forEach(({ weight, tense, words }) => {
    words.forEach(w => { map[w] = { weight, tense }; });
  });
  return map;
})();

// Persian verbs are usually negated at the END of the clause ("خوشحال نیستم"),
// so a Persian negator must also flip the emotion words BEFORE it, not just after.
const PERSIAN_NEGATORS = new Set([
  'نه','نیست','نبود','نیستم','نبودم','نداره','ندارم','نداشت','هیچ','هیچی',
  'هیچوقت','هرگز','نمی','نمیشه','نمیشد','نکن','نکردم',
  // NOTE: 'اصلا'/'ابدا' are NOT listed here. They are emphasis particles that
  // almost always co-occur with a real negator ("اصلا خوب نیست"). Treating them
  // as independent negators caused a double-negation that cancelled out. They
  // are handled as negation-emphasis intensifiers instead (see INTENSIFIERS).
]);
const hasPersian = (w) => /[ا-یآ]/.test(w);

// Common Persian enclitic suffixes (personal endings / possessives) that get
// stuck onto emotion words: خوشحالم، غمگینه، ترسیدم… Strip them so the base
// word still matches the lexicon.
const PERSIAN_SUFFIXES = ['یم','ید','ند','شان','تان','مان','ام','ات','اش','م','ت','ش','ه','ی'];
function stripPersianSuffix(w) {
  if (!hasPersian(w)) return null;
  for (const suf of PERSIAN_SUFFIXES) {
    if (w.length > suf.length + 1 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return null;
}
// Detect an attached Persian verbal negation prefix ("نمی‌ترسم", "نمیترسم",
// "نترس"). Returns the emotion base inside the negated verb, or null.
// e.g. "نمیترسم" → "ترس" (fear), so the sentence reads as negated fear.
function stripPersianNegPrefix(w) {
  if (!hasPersian(w)) return null;
  let body = null;
  if (w.startsWith('نمی')) body = w.slice(3).replace(/^‌/, '');
  else if (w.startsWith('نمى')) body = w.slice(3).replace(/^‌/, '');
  if (!body) return null;
  // try the body and its suffix-stripped form against the lexicon
  if (WORD_LOOKUP[body]) return body;
  const base = stripPersianSuffix(body);
  if (base && WORD_LOOKUP[base]) return base;
  return null;
}

// look up a word, falling back to a suffix-stripped Persian base form
function lookupWord(w) {
  if (WORD_LOOKUP[w]) return WORD_LOOKUP[w];
  const base = stripPersianSuffix(w);
  if (base && WORD_LOOKUP[base]) return WORD_LOOKUP[base];
  return null;
}

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

// Normalize Arabic-form characters that Arabic/mobile keyboards produce to their
// Persian equivalents, and strip Arabic diacritics/tatweel, so the lexicon
// matches regardless of how the user typed (ك→ک, ي/ﻯ→ی, ة→ه, remove harakat).
function normalizePersian(s) {
  return s
    .replace(/\u0643/g, '\u06A9')          // ك → ک
    .replace(/[\u064A\u0649]/g, '\u06CC')  // ي, ى → ی
    .replace(/\u0629/g, '\u0647')          // ة → ه
    .replace(/[\u064B-\u0652\u0640]/g, ''); // harakat + tatweel
}

export function detectMood(text) {
  let lower = normalizePersian(text.toLowerCase()).replace(/’/g, "'");

  // ── Phrase pass (runs FIRST) ──────────────────────────────────
  // Detect multi-word expressions before splitting into words, so the SENTENCE's
  // combined meaning is captured — not just isolated words. Matched phrases are
  // removed from the text so their component words aren't double-counted, and:
  //   • fixed-emotion phrases add their weight/tense directly
  //   • intensify phrases are stored and applied to the dominant emotion at the end
  let phraseScore = 0, phraseTense = 0, phraseNostalgia = false;
  const pendingIntensify = [];
  for (const ph of PHRASES_SORTED) {
    let idx;
    // match on word boundaries within the (space-padded) text
    const padded = ' ' + lower + ' ';
    if (padded.includes(' ' + ph.p + ' ')) {
      // remove ALL occurrences of the phrase from the working text
      lower = (' ' + lower + ' ').split(' ' + ph.p + ' ').join('  ').trim().replace(/\s+/g, ' ');
      if (ph.intensify !== undefined) {
        pendingIntensify.push(ph.intensify);
      } else {
        phraseScore += ph.weight || 0;
        phraseTense += ph.tense || 0;
        if (ph.nostalgia) phraseNostalgia = true;
      }
    }
  }

  const words = lower.match(/[a-zA-Z’'ا-یآ‌]+/g) || [];

  // Normalize curly apostrophes up front.
  const toks = words.map(w => w.replace(/’/g, "'"));

  // ── Pass 1: build a per-token table of emotion hits with intensifier scaling ──
  // Each entry records the (possibly multiplied) weight/tense at its position,
  // so Pass 2 can apply negation flips that reach either forward (English) or
  // backward (Persian clause-final negation) into neighboring tokens.
  const n = toks.length;
  const entry = new Array(n).fill(null); // { w, t } emotion contribution per token
  const isNeg = new Array(n).fill(false);
  const isNegFa = new Array(n).fill(false);
  const selfNeg = new Array(n).fill(false); // token carries its own attached negation

  let multLeft = 0, pendingMult = 1;
  for (let i = 0; i < n; i++) {
    const w = toks[i];

    if (NEGATORS.has(w))         isNeg[i] = true;
    if (PERSIAN_NEGATORS.has(w)) isNegFa[i] = true;

    if (INTENSIFIERS[w] !== undefined) { pendingMult = INTENSIFIERS[w]; multLeft = MODIFIER_SCOPE + 1; }

    // "نمیترسم" style: an emotion verb with an attached negation prefix — it
    // contributes the emotion of its body AND negates itself in place.
    const negBody = stripPersianNegPrefix(w);
    let hit = null;
    if (negBody) {
      hit = WORD_LOOKUP[negBody];
      selfNeg[i] = true;
    } else {
      hit = lookupWord(w);
    }

    if (hit) {
      let wWeight = hit.weight, wTense = hit.tense;
      if (multLeft > 0) { wWeight *= pendingMult; wTense *= pendingMult; }
      entry[i] = { w: wWeight, t: wTense };
    }
    if (multLeft > 0) multLeft--;
  }

  // ── Pass 2: apply negation, then sum ──
  // English/general negators flip the emotion words that FOLLOW them.
  // Persian negators additionally flip emotion words BEFORE them in the clause,
  // because Persian negates the verb at the end ("خوشحال نیستم" = not happy).
  // Count how many negations reach each emotion token; an EVEN count cancels
  // out ("not not happy" stays positive), an ODD count flips it.
  const flipCount = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (selfNeg[i] && entry[i]) flipCount[i]++; // attached-prefix negation flips itself
    if (isNeg[i]) {
      for (let j = i + 1; j <= i + MODIFIER_SCOPE && j < n; j++)
        if (entry[j]) flipCount[j]++;
    }
    if (isNegFa[i]) {
      for (let j = i + 1; j <= i + MODIFIER_SCOPE && j < n; j++) if (entry[j]) flipCount[j]++;
      for (let j = i - 1; j >= i - MODIFIER_SCOPE && j >= 0; j--) if (entry[j]) flipCount[j]++;
    }
  }
  const flipped = flipCount.map(c => c % 2 === 1);

  let score = 0, tense = 0;
  for (let i = 0; i < n; i++) {
    if (!entry[i]) continue;
    let { w: wWeight, t: wTense } = entry[i];
    if (flipped[i]) {
      // invert polarity, dampen slightly (negated emotion ≠ full opposite),
      // and nudge tension up (negation adds friction/ambiguity)
      wWeight = -wWeight * 0.85;
      wTense = Math.abs(wTense) * 0.5 + 0.15;
    }
    score += wWeight;
    tense += wTense;
  }

  // fold in the fixed-emotion phrases detected up front
  score += phraseScore;
  tense += phraseTense;

  // Apply phrase intensifiers to the DOMINANT emotion: they amplify whatever the
  // sentence already feels (e.g. "to death" makes "love" MORE loving, "scared"
  // MORE scared) rather than introducing their own polarity.
  for (const factor of pendingIntensify) {
    score *= factor;
    tense *= factor;
  }

  const exclaim  = (text.match(/!/g) || []).length;
  const question = (text.match(/\?/g) || []).length;
  const ellipsis = (text.match(/\.\.\./g) || []).length;
  score += exclaim * 0.4;
  score -= question * 0.25;
  score -= ellipsis * 0.3;
  tense += exclaim * 0.5;

  const norm = score / Math.max(3, Math.sqrt(words.length));
  const tenseNorm = tense / Math.max(3, Math.sqrt(words.length));

  // How much emotional signal is actually present (not just neutral filler words).
  // Phrases count too, so a sentence like "i love you to death" is never treated
  // as neutral even though its remaining loose words might be.
  const emotionHits = entry.reduce((a, e) => a + (e ? 1 : 0), 0);
  const hadPhrase = phraseScore !== 0 || phraseTense !== 0 || pendingIntensify.length > 0 || phraseNostalgia;
  const emotionDensity = hadPhrase ? 1 : emotionHits / Math.max(1, words.length);

  let idx;
  if (emotionDensity < 0.12) {
    // NEUTRAL text (no real feeling words): don't force it into the dark middle
    // of the spectrum — that made every plain sentence sound the same & gloomy.
    // Instead pick a *bright-to-mid* mode that VARIES by the text itself (hash),
    // so ordinary writing sounds open, and different neutral texts differ.
    const h = hashText(text);
    // choose among the brighter half (indices 8..15 = dorian→major side)
    idx = 8 + (h % (MODE_ORDER.length - 8));
  } else {
    // map continuous score onto 16-mode spectrum
    const clamped = Math.max(-1.5, Math.min(1.5, norm));
    idx = Math.round(((clamped + 1.5) / 3.0) * (MODE_ORDER.length - 1));
    // high tension → pull toward the exotic/unstable cluster (first 5 modes)
    if (tenseNorm > 0.5 && idx > 3) idx = Math.max(1, idx - 4);
  }

  idx = Math.max(0, Math.min(MODE_ORDER.length - 1, idx));
  return { mode: MODE_ORDER[idx], normScore: norm, tenseScore: tenseNorm };
}

// ── Text signal layer ─────────────────────────────────────────
// Beyond a single mood, extract several independent signals from the text so
// that different atmospheric sound layers can each be tied to the aspect of the
// writing they belong to (drone→darkness, crackle→nostalgia, hiss→tension, …).
// All signals are normalized 0..1 and derived deterministically from the text.
//
// Returns:
//   mode        — the chosen musical mode (same as detectMood)
//   darkness    — 0 bright .. 1 dark (where the mood sits in MODE_ORDER)
//   tension     — 0 calm .. 1 tense/unstable (anger/fear/exclamation)
//   nostalgia   — 0 .. 1 how much the text evokes memory/the past
//   density     — 0 .. 1 how emotionally saturated the text is (emotion words / total)
//   valence     — signed mood score (negative = dark, positive = bright)
export function analyzeText(text) {
  const m = detectMood(text);
  const lower = normalizePersian(text.toLowerCase());
  const words = lower.match(/[a-zA-Z’'ا-یآ‌]+/g) || [];
  const toks = words.map(w => w.replace(/’/g, "'"));
  const n = Math.max(1, toks.length);

  // darkness from mode position (MODE_ORDER runs dark → bright)
  const mi = MODE_ORDER.indexOf(m.mode);
  const darkness = mi < 0 ? 0.5 : 1 - (mi / (MODE_ORDER.length - 1));

  // tension straight from the detector, squashed into 0..1
  const tension = Math.max(0, Math.min(1, m.tenseScore));

  // nostalgia: fraction of tokens that are nostalgia-category words,
  // plus a boost if a nostalgia PHRASE ("those days", "یاد گذشته", …) is present.
  const nostalgiaWords = new Set(EMOTION_LEXICON.nostalgia.words);
  let nostalgiaHits = 0, emotionHits = 0;
  for (const w of toks) {
    const base = w; // already normalized
    if (nostalgiaWords.has(base)) nostalgiaHits++;
    if (WORD_LOOKUP[base]) emotionHits++;
  }
  const padded = ' ' + lower.replace(/’/g, "'") + ' ';
  const phraseNostalgia = PHRASES.some(ph => ph.nostalgia && padded.includes(' ' + ph.p + ' '));
  let nostalgia = Math.max(0, Math.min(1, (nostalgiaHits / n) * 6)); // scaled — even a little memory reads
  if (phraseNostalgia) nostalgia = Math.max(nostalgia, 0.7);
  const density  = Math.max(0, Math.min(1, emotionHits / n));

  return {
    mode: m.mode,
    valence: m.normScore,
    darkness,
    tension,
    nostalgia,
    density,
  };
}

// Root candidates — two octave layers so dark moods can go lower, bright moods higher
export function noteFreq(semisFromA2) { return 110.00 * Math.pow(2, semisFromA2 / 12); }
// A1 through G#2 (low register) + A2 through G#3 (mid register) = 24 roots
export const ROOT_CANDIDATES_LOW  = Array.from({ length: 12 }, (_, i) => noteFreq(i - 12)); // A1–G#2
export const ROOT_CANDIDATES_MID  = Array.from({ length: 12 }, (_, i) => noteFreq(i));      // A2–G#3

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

// ── Chord voicing library ─────────────────────────────────────
// A chord is defined as a set of SCALE-DEGREE offsets (steps within the current
// scale), NOT fixed frequencies — so every voicing is automatically built from
// currentScale and stays perfectly in-key in any mode. Offsets ≥ 7 wrap to the
// next octave. Voicings are grouped by feel so the piece can pick a chord that
// matches the text's mood at a meaningful moment (end of a sentence, a strong
// word, an emotional peak). Kept as brief, occasional colour — not the backbone.
export const CHORD_VOICINGS = {
  // warm / bright / resolved — for positive, hopeful, loving text
  bright: [
    [0, 2, 4],           // triad (I)
    [0, 2, 4, 6],        // 7th
    [0, 2, 4, 8],        // add9 (9th an octave up)
    [0, 2, 4, 6, 8],     // 9th
    [0, 4, 7, 9],        // spread: root, 5th, up-root, up-3rd
    [0, 2, 4, 7],        // triad + octave
    [0, 1, 4],           // sus2
    [0, 3, 4],           // sus4
    [0, 2, 5],           // 6th (add 6)
    [0, 2, 4, 5],        // triad + 6th
    [0, 4, 9, 11],       // wide, airy
    [0, 2, 4, 6, 9],     // maj9 spread
    [0, 7, 9, 11],       // high, glassy
    [0, 2, 7, 9],        // open, floating
  ],
  // neutral / gentle — for plain or calm text
  calm: [
    [0, 4],              // bare 5th (open, restful)
    [0, 7],              // octave
    [0, 2, 4],           // simple triad
    [0, 4, 7],           // root, 5th, octave — very open
    [0, 2, 4, 7],
    [0, 4, 9],           // quiet spread
    [0, 2, 7],           // sus-ish open
    [0, 3, 7],
    [0, 4, 6],
    [0, 2, 4, 11],       // gentle high colour
  ],
  // dark / sad / heavy — lower, closer, minor-leaning voicings
  dark: [
    [0, 2, 4],           // triad (minor in dark modes)
    [0, 2, 4, 6],        // min7
    [0, 2, 6],           // no-5th, hollow
    [-3, 0, 2, 4],       // 5th in the bass, heavy
    [0, 2, 4, -3],       // low root doubling
    [-7, 0, 2, 4],       // deep root
    [0, 1, 2, 4],        // cluster-ish, mournful
    [0, 2, 4, 5],
    [0, 2, 3, 4],        // dense, dark
    [-3, 0, 4],          // low, open, bleak
    [0, 3, 4, 6],        // suspended, unresolved
  ],
  // tense / unstable / anxious — dissonant, exotic, edgy voicings
  tense: [
    [0, 1, 4],           // b2 cluster tension
    [0, 1, 2, 4],        // tight cluster
    [0, 3, 6],           // tritone-ish (in modes that allow it)
    [0, 2, 5, 6],        // added dissonance
    [0, 1, 3, 6],        // unstable
    [0, 6, 7],           // leading, unresolved
    [0, 1, 4, 5],        // stacked seconds
    [0, 2, 4, 1],        // triad + jarring 2nd on top
    [0, 3, 4, 6],
    [0, 1, 6],           // sparse, anxious
  ],
};

// Build actual frequencies for a voicing (array of scale-degree offsets) from a
// scale, starting at a given root degree. Offsets can be negative (octave down)
// or ≥ scale length (octave up) — the math keeps everything octave-correct and
// therefore in-key.
export function buildVoicing(scale, offsets, rootDegree = 0) {
  const len = scale.length;
  return offsets.map(off => {
    const deg = rootDegree + off;
    const idx = ((deg % len) + len) % len;      // wrapped scale index
    const octShift = Math.floor(deg / len);      // how many octaves up/down
    return scale[idx] * Math.pow(2, octShift);
  });
}
