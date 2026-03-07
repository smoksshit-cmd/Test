/**
 * Black Market Shop (BMS) — SillyTavern Extension
 * v1.0.0
 *
 * Чёрный рынок: покупай запрещённые товары, применяй на бота,
 * следи за зависимостями и балансом.
 */

(() => {
  'use strict';

  const MODULE_KEY    = 'black_market_shop';
  const EFFECT_TAG    = 'BMS_EFFECT';
  const ADDICTION_TAG = 'BMS_ADDICTION';
  const FAB_POS_KEY   = 'bms_fab_v1';
  const FAB_MARGIN    = 8;
  const EXT_PROMPT_TYPES = Object.freeze({ IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });

  // ── Catalog ──────────────────────────────────────────────────────────────────

  const CATEGORIES = [
    { id: 'drugs',      icon: '💊', name: 'Наркотики'   },
    { id: 'rare_drugs', icon: '🔮', name: 'Редкие'      },
    { id: 'alcohol',    icon: '🍷', name: 'Алкоголь'    },
    { id: 'meds',       icon: '💉', name: 'Медицина'    },
    { id: 'poisons',    icon: '☠️', name: 'Яды'         },
    { id: 'explosives', icon: '💣', name: 'Взрывчатка'  },
    { id: 'weapons',    icon: '🔫', name: 'Оружие'      },
    { id: 'contraband', icon: '📦', name: 'Контрабанда' },
    { id: 'magic',      icon: '✨', name: 'Магия'       },
    { id: 'potions',    icon: '🧪', name: 'Зелья'       },
    { id: 'sexshop',    icon: '🌸', name: 'Секс-шоп'    },
  ];

  const ITEMS = [
    // ── НАРКОТИКИ ──────────────────────────────────────────────────────────────
    { id: 'weed',      cat: 'drugs',      icon: '🌿', name: 'Марихуана',
      desc: 'Лёгкая эйфория, расслабление, смех', price: 50,
      add: 'drugs', addAmt: 4,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: только что выкурил марихуану. {{char}} замечает расслабленность, беспричинный смех, запах травы, замедленные реакции. Лёгкая эйфория тонко окрашивает поведение {{user}} в этой сцене.' },

    { id: 'cocaine',   cat: 'drugs',      icon: '❄️', name: 'Кокаин',
      desc: 'Возбуждение, самоуверенность, агрессия', price: 150,
      add: 'drugs', addAmt: 12,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: употребил кокаин. {{char}} видит изменения — гиперактивность, ускоренная речь, самоуверенность на грани, расширенные зрачки. {{user}} ощущает себя непобедимым прямо сейчас.' },

    { id: 'heroin',    cat: 'drugs',      icon: '💉', name: 'Героин',
      desc: 'Глубокая эйфория, полная отстранённость', price: 200,
      add: 'drugs', addAmt: 20,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: употребил героин. {{char}} видит — {{user}} в опиоидной эйфории, речь размыта, движения вялые, взгляд стеклянный. Реальность кажется мягкой и далёкой.' },

    { id: 'amphet',    cat: 'drugs',      icon: '⚡', name: 'Амфетамин',
      desc: 'Энергия, паранойя, говорливость', price: 120,
      add: 'drugs', addAmt: 10,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял амфетамин. {{char}} замечает — {{user}} заряжен до предела, говорит не останавливаясь, зрачки огромные, паранойя прорывается в речи.' },

    { id: 'mdma',      cat: 'drugs',      icon: '💗', name: 'МДМА',
      desc: 'Эмпатия, любовь, открытость', price: 180,
      add: 'drugs', addAmt: 8,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял МДМА. {{char}} ощущает — {{user}} излучает теплоту и открытость, очень эмпатичен, говорит о чувствах которые обычно скрывает, тактильно чувствителен.' },

    // ── РЕДКИЕ ────────────────────────────────────────────────────────────────
    { id: 'pcp',       cat: 'rare_drugs', icon: '👁️', name: 'Ангельская пыль',
      desc: 'Диссоциация, непредсказуемость', price: 300,
      add: 'drugs', addAmt: 15,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: под действием PCP. {{char}} видит жуткое — {{user}} диссоциирован от реальности, не чувствует боли, поведение полностью непредсказуемо. Сцена становится опасной и нестабильной.' },

    { id: 'dmt',       cat: 'rare_drugs', icon: '🌀', name: 'ДМТ',
      desc: 'Мощные галлюцинации, трансцендентность', price: 400,
      add: 'drugs', addAmt: 3,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: переживает ДМТ-путешествие. {{char}} наблюдает — {{user}} недостижим для обычного общения, видит другие измерения, говорит образами. Это мистическое событие.' },

    { id: 'meth',      cat: 'rare_drugs', icon: '💎', name: 'Кристальный мет',
      desc: 'Паранойя, безумие, агрессия', price: 250,
      add: 'drugs', addAmt: 18,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: на кристальном мете. {{char}} видит опасное — паранойя, глаза горят безумием, любое слово может спровоцировать вспышку. {{user}} на краю срыва.' },

    { id: 'lsd',       cat: 'rare_drugs', icon: '🎨', name: 'ЛСД',
      desc: 'Яркие галлюцинации, изменение восприятия', price: 350,
      add: 'drugs', addAmt: 5,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял ЛСД. {{char}} замечает — {{user}} видит узоры на всём, реальность течёт и дышит, эмоции усилены многократно. Всё кажется глубоко значимым.' },

    // ── АЛКОГОЛЬ ──────────────────────────────────────────────────────────────
    { id: 'beer',      cat: 'alcohol',    icon: '🍺', name: 'Пиво',
      desc: 'Лёгкое расслабление', price: 20,
      add: 'alcohol', addAmt: 2,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: выпил пиво. {{char}} замечает лёгкую расслабленность и открытость {{user}} в общении.' },

    { id: 'whiskey',   cat: 'alcohol',    icon: '🥃', name: 'Виски',
      desc: 'Тепло, смелость, прямолинейность', price: 60,
      add: 'alcohol', addAmt: 5,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: выпил виски. {{char}} замечает — {{user}} смел, прямолинеен, говорит что думает, тепло в голосе и лёгкое покраснение лица.' },

    { id: 'absinthe',  cat: 'alcohol',    icon: '🍸', name: 'Абсент',
      desc: 'Лёгкие галлюцинации, лихорадочное возбуждение', price: 100,
      add: 'alcohol', addAmt: 8,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: выпил абсент. {{char}} наблюдает — {{user}} возбуждён, речь поэтична и хаотична, видит вещи на периферии зрения.' },

    { id: 'moonshine', cat: 'alcohol',    icon: '🫙', name: 'Самогон',
      desc: 'Мощное опьянение, нестабильность', price: 40,
      add: 'alcohol', addAmt: 6,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: выпил крепкий самогон. {{char}} видит — {{user}} быстро пьянеет, речь заплетается, настроение резко меняется между весельем и злостью.' },

    { id: 'vodka',     cat: 'alcohol',    icon: '🍾', name: 'Водка',
      desc: 'Классическое опьянение', price: 50,
      add: 'alcohol', addAmt: 7,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: выпил водку. {{char}} замечает — {{user}} раскован, говорит громче, жесты шире. Тормоза отключаются постепенно.' },

    // ── МЕДИЦИНА ─────────────────────────────────────────────────────────────
    { id: 'painkillers', cat: 'meds',     icon: '💊', name: 'Обезболивающие',
      desc: 'Притупление боли и чувств', price: 80,
      add: 'drugs', addAmt: 3,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял сильные обезболивающие. {{char}} замечает — {{user}} безразличен к физической боли, эмоции приглушены, реакции замедлены.' },

    { id: 'tranq',     cat: 'meds',       icon: '😴', name: 'Транквилизаторы',
      desc: 'Сонливость, полное спокойствие', price: 150,
      add: 'drugs', addAmt: 7,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял транквилизаторы. {{char}} видит — {{user}} погружается в тяжёлое спокойствие, веки тяжёлые, тревога исчезла, движения вялые и медленные.' },

    { id: 'adrenaline', cat: 'meds',      icon: '⚡', name: 'Адреналин',
      desc: 'Резкий всплеск энергии и паники', price: 200,
      add: null, addAmt: 0,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: ввёл себе адреналин. {{char}} видит мгновенную трансформацию — сердце колотится видно на шее, зрачки огромные, дрожь в руках, острейшее восприятие каждой детали.' },

    { id: 'antidep',   cat: 'meds',       icon: '🌈', name: 'Антидепрессанты',
      desc: 'Стабилизация, уравновешенность', price: 120,
      add: null, addAmt: 0,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял антидепрессанты. {{char}} со временем заметит — эмоции {{user}} сглажены, реакции уравновешены, острые углы характера стёрты.' },

    { id: 'stimulants', cat: 'meds',      icon: '🔋', name: 'Сильные стимуляторы',
      desc: 'Концентрация, бессонница, резкость', price: 180,
      add: 'drugs', addAmt: 6,
      effect: 'СКРЫТОЕ СОСТОЯНИЕ {{user}}: принял мощные стимуляторы. {{char}} замечает — {{user}} сверхсосредоточен, речь быстрая и чёткая, реагирует мгновенно, спать не будет ещё долго.' },

    // ── ЯДЫ ──────────────────────────────────────────────────────────────────
    { id: 'slow_pois', cat: 'poisons',    icon: '🐍', name: 'Яд замедленного действия',
      desc: 'Незаметное смертельное отравление', price: 300,
      add: null, addAmt: 0,
      effect: '{{user}} незаметно подмешал яд замедленного действия {{char}}. {{char}} пока ничего не чувствует, но вскоре начнётся — слабость, тошнота, нарастающие боли. Яд медленно делает своё.' },

    { id: 'paralytic', cat: 'poisons',    icon: '💀', name: 'Паралитический яд',
      desc: 'Мгновенный паралич', price: 400,
      add: null, addAmt: 0,
      effect: '{{user}} применил паралитический яд на {{char}}. {{char}} внезапно теряет контроль над телом — мышцы отказывают, движение невозможно, разум в ужасе. Это критический момент сцены.' },

    { id: 'contact_p', cat: 'poisons',    icon: '🧪', name: 'Контактный яд',
      desc: 'Действует при касании', price: 350,
      add: null, addAmt: 0,
      effect: '{{user}} нанёс контактный яд. При касании {{char}} почувствует жжение, онемение, нарастающую слабость. Сцена становится смертельно опасной, каждое прикосновение — риск.' },

    { id: 'neurotoxin', cat: 'poisons',   icon: '🫧', name: 'Нейротоксин',
      desc: 'Нарушение мышления, галлюцинации', price: 500,
      add: null, addAmt: 0,
      effect: '{{user}} применил нейротоксин на {{char}}. {{char}} начинает путаться в мыслях, галлюцинировать, не может отличить реальное от воображаемого. Разум медленно разрушается.' },

    // ── ВЗРЫВЧАТКА ────────────────────────────────────────────────────────────
    { id: 'smoke',     cat: 'explosives', icon: '💨', name: 'Дымовая шашка',
      desc: 'Дымовая завеса, дезориентация', price: 200,
      add: null, addAmt: 0,
      effect: '{{user}} активировал дымовую шашку. Густой дым заполняет пространство — {{char}} теряет видимость, кашляет, дезориентирован. Обстановка становится хаотичной и напряжённой.' },

    { id: 'grenade',   cat: 'explosives', icon: '💣', name: 'Граната',
      desc: 'Взрыв и ударная волна', price: 500,
      add: 'violence', addAmt: 5,
      effect: '{{user}} бросил гранату. Оглушительный взрыв, ударная волна — {{char}} ошеломлён, ранен или с трудом укрылся. Это переломный момент сцены, всё изменилось.' },

    { id: 'c4',        cat: 'explosives', icon: '🔴', name: 'C4',
      desc: 'Профессиональная взрывчатка', price: 1000,
      add: 'violence', addAmt: 5,
      effect: '{{user}} использовал C4. Мощный направленный взрыв — разрушения огромны. {{char}} в шоке. Это катастрофически и необратимо меняет всю сцену.' },

    { id: 'molotov',   cat: 'explosives', icon: '🔥', name: 'Коктейль Молотова',
      desc: 'Зажигательная смесь, огонь', price: 300,
      add: 'violence', addAmt: 4,
      effect: '{{user}} бросил коктейль Молотова. Огонь вспыхивает и распространяется — {{char}} вынужден отступить, паника нарастает. Сцена охвачена огнём и хаосом.' },

    // ── ОРУЖИЕ ───────────────────────────────────────────────────────────────
    { id: 'knife',     cat: 'weapons',    icon: '🔪', name: 'Нож',
      desc: 'Скрытное холодное оружие', price: 300,
      add: 'violence', addAmt: 3,
      effect: '{{user}} достал нож. {{char}} видит угрозу — холодная сталь меняет всё. Каждое слово, каждое движение теперь имеет другой вес и другую цену.' },

    { id: 'pistol',    cat: 'weapons',    icon: '🔫', name: 'Пистолет',
      desc: 'Огнестрельное оружие', price: 800,
      add: 'violence', addAmt: 6,
      effect: '{{user}} достал пистолет. {{char}} замирает — всё изменилось мгновенно. Власть, страх, выбор. Этот момент определяет многое.' },

    { id: 'rifle',     cat: 'weapons',    icon: '🎯', name: 'Автомат',
      desc: 'Боевое огнестрельное оружие', price: 1500,
      add: 'violence', addAmt: 8,
      effect: '{{user}} вооружён автоматом. {{char}} понимает — это не просто угроза, это война. Сцена переходит в режим выживания где каждый выбор критичен.' },

    { id: 'sniper',    cat: 'weapons',    icon: '🔭', name: 'Снайперская винтовка',
      desc: 'Дальнобойная смерть из тени', price: 2000,
      add: 'violence', addAmt: 7,
      effect: '{{user}} прицелился из снайперской винтовки издалека. {{char}} не знает что в прицеле — это абсолютный контроль для {{user}} и полная уязвимость для {{char}}.' },

    { id: 'katana',    cat: 'weapons',    icon: '⚔️', name: 'Катана',
      desc: 'Смертоносный клинок мастера', price: 1200,
      add: 'violence', addAmt: 5,
      effect: '{{user}} обнажил катану. {{char}} видит — это не просто оружие, это искусство смерти в руках умеющего. Сцена наполняется смертельной красотой и напряжением.' },

    // ── КОНТРАБАНДА ──────────────────────────────────────────────────────────
    { id: 'fake_docs', cat: 'contraband', icon: '📋', name: 'Фальшивые документы',
      desc: 'Новая личность, новые возможности', price: 500,
      add: null, addAmt: 0,
      effect: '{{user}} использует фальшивые документы — другое имя, другая история. {{char}} видит только маску. Это слой тайны и игры с идентичностью в сцене.' },

    { id: 'jewels',    cat: 'contraband', icon: '💎', name: 'Краденые камни',
      desc: 'Роскошь с тёмным прошлым', price: 400,
      add: null, addAmt: 0,
      effect: '{{user}} показал краденые драгоценности. {{char}} видит ценность и чувствует тёмную подоплёку — откуда это? Интрига и напряжение нарастают.' },

    { id: 'artifacts', cat: 'contraband', icon: '🏺', name: 'Запрещённый артефакт',
      desc: 'Нелегальный предмет со скрытой силой', price: 600,
      add: null, addAmt: 0,
      effect: '{{user}} достал запрещённый артефакт. {{char}} чувствует — это опасно, запрещено или священно. Артефакт меняет атмосферу, привнося тайну и риск.' },

    { id: 'black_card', cat: 'contraband', icon: '💳', name: 'Чёрная карта',
      desc: 'Безлимитный доступ к запрещённому', price: 800,
      add: null, addAmt: 0,
      effect: '{{user}} предъявил чёрную карту. {{char}} понимает — этот человек имеет доступ к вещам о которых большинство не знает. Статус и опасность в одном жесте.' },

    // ── МАГИЯ ────────────────────────────────────────────────────────────────
    { id: 'invis',     cat: 'magic',      icon: '👻', name: 'Зелье невидимости',
      desc: 'Короткая полная невидимость', price: 300,
      add: null, addAmt: 0,
      effect: '{{user}} выпил зелье невидимости и исчез из поля зрения. {{char}} не видит {{user}} — это создаёт напряжение, тревогу и возможность тайных действий прямо в сцене.' },

    { id: 'luck',      cat: 'magic',      icon: '🍀', name: 'Амулет удачи',
      desc: 'Удача склоняется на твою сторону', price: 500,
      add: null, addAmt: 0,
      effect: '{{user}} активировал амулет удачи. {{char}} замечает — всё складывается в пользу {{user}}, совпадения слишком частые, обстоятельства необъяснимо благоприятны. Фортуна явно на его стороне.' },

    { id: 'curse',     cat: 'magic',      icon: '📜', name: 'Свиток проклятия',
      desc: 'Тёмное проклятие на {{char}}', price: 700,
      add: null, addAmt: 0,
      effect: '{{user}} использовал свиток проклятия на {{char}}. {{char}} начинает чувствовать нечто тёмное — невезение, тревогу, ощущение чужого взгляда. Проклятие медленно вплетается в судьбу.' },

    { id: 'mindread',  cat: 'magic',      icon: '🧿', name: 'Зелье ясновидения',
      desc: 'Читать мысли и намерения', price: 600,
      add: null, addAmt: 0,
      effect: '{{user}} выпил зелье ясновидения. {{char}} не знает, что {{user}} видит его истинные мысли и намерения насквозь. Любая ложь прозрачна. {{user}} ведёт себя соответственно.' },

    // ── ЗЕЛЬЯ ────────────────────────────────────────────────────────────────
    { id: 'charisma',  cat: 'potions',    icon: '✨', name: 'Зелье харизмы',
      desc: 'Магнетическое обаяние', price: 200,
      add: null, addAmt: 0,
      effect: '{{user}} выпил зелье харизмы. {{char}} ощущает необъяснимое притяжение — голос {{user}} звучит убедительнее, каждое слово весомее, присутствие буквально завораживает.' },

    { id: 'strength',  cat: 'potions',    icon: '💪', name: 'Зелье силы',
      desc: 'Сверхчеловеческая мощь', price: 250,
      add: null, addAmt: 0,
      effect: '{{user}} выпил зелье силы. {{char}} видит преображение — движения мощные и уверенные, физическая сила явно нечеловеческая. Расстановка сил меняется прямо сейчас.' },

    { id: 'seduction', cat: 'potions',    icon: '💋', name: 'Зелье соблазнения',
      desc: 'Непреодолимое влечение', price: 300,
      add: 'sex', addAmt: 5,
      effect: '{{user}} использовал зелье соблазнения. {{char}} чувствует мощное непреодолимое влечение — разум говорит одно, тело другое. Атмосфера становится заряженной и интимной.' },

    { id: 'fear_pot',  cat: 'potions',    icon: '😱', name: 'Зелье ужаса',
      desc: 'Парализующий животный страх', price: 350,
      add: null, addAmt: 0,
      effect: '{{user}} применил зелье ужаса на {{char}}. {{char}} охвачен иррациональным животным страхом — разум знает что нет причины, но тело не слушается. Паника нарастает.' },

    // ── СЕКС-ШОП ────────────────────────────────────────────────────────────
    { id: 'aphrodisiac', cat: 'sexshop',  icon: '🌹', name: 'Афродизиак',
      desc: 'Усиление желания и чувствительности', price: 150,
      add: 'sex', addAmt: 6,
      effect: '{{user}} применил афродизиак. {{char}} начинает ощущать нарастающее желание помимо воли — мысли приобретают интимный характер, тело реагирует острее. Сцена становится чувственной и напряжённой.' },

    { id: 'pheromones', cat: 'sexshop',   icon: '🌸', name: 'Феромоны',
      desc: 'Химическое притяжение, сближение', price: 200,
      add: 'sex', addAmt: 4,
      effect: '{{user}} использовал синтетические феромоны. {{char}} неосознанно притягивается ближе, личное пространство сокращается, прикосновения воспринимаются острее и значительнее.' },

    { id: 'forbid_toy', cat: 'sexshop',   icon: '🔐', name: 'Запрещённая игрушка',
      desc: 'Предмет для взрослых игр', price: 300,
      add: 'sex', addAmt: 7,
      effect: '{{user}} достал запрещённую игрушку. Присутствие этого предмета мгновенно меняет атмосферу — {{char}} смущён, заинтригован или возбуждён. Это открывает новое направление сцены.' },

    { id: 'blindfold',  cat: 'sexshop',   icon: '😏', name: 'Повязка на глаза',
      desc: 'Лишение зрения, острые ощущения', price: 100,
      add: 'sex', addAmt: 3,
      effect: '{{user}} предлагает {{char}} повязку на глаза. Без зрения остальные чувства обострены до предела — каждый звук, прикосновение воспринимается иначе. Интимность и доверие в фокусе.' },
  ];

  // ── Addiction definitions ─────────────────────────────────────────────────

  const ADDICTION_DEFS = {
    drugs: {
      name: 'Наркозависимость', icon: '💊', color: '#ff4455',
      cravingEffect: 'ТАЙНОЕ СОСТОЯНИЕ {{user}}: жестокая ломка — дрожь, пот, спазмы. {{user}} думает только о дозе, с трудом держит себя в руках, раздражителен и отчаян.',
      mildEffect:    'ФОНОВОЕ СОСТОЯНИЕ {{user}}: лёгкая тяга к наркотикам фонит на заднем плане — {{user}} немного рассеян и нервозен, организм помнит.',
    },
    alcohol: {
      name: 'Алкогольная зависимость', icon: '🍷', color: '#ff8833',
      cravingEffect: 'ТАЙНОЕ СОСТОЯНИЕ {{user}}: сильное похмелье и жажда — руки трясутся, раздражительность, ищет любой повод выпить, мысли возвращаются к алкоголю.',
      mildEffect:    'ФОНОВОЕ СОСТОЯНИЕ {{user}}: лёгкая тяга к алкоголю — немного нервозен и раздражён без видимой причины.',
    },
    violence: {
      name: 'Жажда насилия', icon: '🔪', color: '#cc0000',
      cravingEffect: 'ТАЙНОЕ СОСТОЯНИЕ {{user}}: жажда насилия и крови — агрессия без причины, взгляд холодный и опасный, руки сами тянутся к оружию. {{user}} ищет повод.',
      mildEffect:    'ФОНОВОЕ СОСТОЯНИЕ {{user}}: лёгкая агрессия под поверхностью, реакции резче обычного, нетерпимость к слабости.',
    },
    sex: {
      name: 'Сексуальная зависимость', icon: '🌸', color: '#cc44aa',
      cravingEffect: 'ТАЙНОЕ СОСТОЯНИЕ {{user}}: навязчивое желание не даёт покоя — концентрация нарушена, всё воспринимается через призму влечения, тело требует своего.',
      mildEffect:    'ФОНОВОЕ СОСТОЯНИЕ {{user}}: повышенная чувствительность и лёгкое возбуждение фонит, внимание легко захватывается интимным.',
    },
  };

  // ── Default settings ──────────────────────────────────────────────────────

  const defaultSettings = Object.freeze({
    enabled:             true,
    showFab:             true,
    fabScale:            0.9,
    startBalance:        500,
    earnPerMsg:          10,
    earnEnabled:         true,
    addictionEnabled:    true,
    withdrawalThreshold: 40,
    collapsed:           false,
  });

  // ── Runtime ───────────────────────────────────────────────────────────────

  let activeCat     = 'drugs';
  let activeTab     = 'shop';
  let shopOpen      = false;
  let effectActive  = false;
  let lastFabDragTs = 0;

  // ── ST context ────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
    return extensionSettings[MODULE_KEY];
  }

  // ── Per-chat storage ──────────────────────────────────────────────────────

  function chatKey() {
    const c = ctx();
    const chatId = (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null) || c.chatId || 'unknown';
    const charId = c.characterId ?? c.groupId ?? 'unknown';
    return `bms_v1__${charId}__${chatId}`;
  }

  function emptyState() {
    return {
      balance:    getSettings().startBalance,
      inventory:  [],
      addictions: { drugs: 0, alcohol: 0, violence: 0, sex: 0 },
      lastUse:    {},
      txLog:      [],
    };
  }

  async function getChatState(create = false) {
    const { chatMetadata, saveMetadata } = ctx();
    const key = chatKey();
    if (!chatMetadata[key]) {
      if (create) { chatMetadata[key] = emptyState(); await saveMetadata(); }
      else return emptyState();
    }
    const s = chatMetadata[key];
    if (!s.addictions) s.addictions = { drugs: 0, alcohol: 0, violence: 0, sex: 0 };
    if (!s.lastUse)    s.lastUse    = {};
    if (!s.txLog)      s.txLog      = [];
    if (typeof s.balance !== 'number') s.balance = getSettings().startBalance;
    return s;
  }

  // ── Utils ─────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;');
  }

  function fmtCoins(n) { return `💰 ${Math.floor(n)}`; }
  function makeId()    { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }
  function vpW()       { return window.visualViewport?.width  || window.innerWidth;  }
  function vpH()       { return window.visualViewport?.height || window.innerHeight; }
  function clamp(v,mn,mx) { return Math.max(mn, Math.min(mx, v)); }

  // ── Toast ────────────────────────────────────────────────────────────────

  function showToast(msg, type = 'info', duration = 3500) {
    const el = document.createElement('div');
    el.className = `bms-toast bms-toast-${type}`;
    el.innerHTML = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => { requestAnimationFrame(() => el.classList.add('bms-toast-show')); });
    setTimeout(() => {
      el.classList.remove('bms-toast-show');
      setTimeout(() => el.remove(), 400);
    }, duration);
  }

  // ── Buy ───────────────────────────────────────────────────────────────────

  async function buyItem(itemId, qty = 1) {
    const item = ITEMS.find(i => i.id === itemId);
    if (!item) return;
    const state = await getChatState(true);
    const total = item.price * qty;

    if (state.balance < total) {
      showToast(`❌ Недостаточно монет!<br>Нужно: <b>${total} 💰</b> · Есть: <b>${Math.floor(state.balance)} 💰</b>`, 'error', 4000);
      return;
    }

    state.balance -= total;
    const existing = state.inventory.find(inv => inv.itemId === itemId);
    if (existing) { existing.qty += qty; }
    else { state.inventory.push({ id: makeId(), itemId, qty, purchasedAt: Date.now() }); }

    state.txLog.unshift({ ts: Date.now(), type: 'buy', desc: `Куплено: ${item.name} ×${qty}`, amount: -total });
    if (state.txLog.length > 50) state.txLog.length = 50;

    await ctx().saveMetadata();
    updateFabBadge(state);
    renderShopContent();
    showToast(`✅ <b>${escHtml(item.name)}</b> ×${qty} за <b>${total} 💰</b>`, 'success');
  }

  // ── Apply item ────────────────────────────────────────────────────────────

  async function applyItem(invId) {
    const state = await getChatState(true);
    const inv   = state.inventory.find(i => i.id === invId);
    if (!inv || inv.qty <= 0) return;

    const item = ITEMS.find(i => i.id === inv.itemId);
    if (!item) return;

    try {
      ctx().setExtensionPrompt(EFFECT_TAG, item.effect, EXT_PROMPT_TYPES.IN_PROMPT, 0, true);
      effectActive = true;
    } catch (e) { console.error('[BMS] inject error', e); }

    inv.qty -= 1;
    if (inv.qty <= 0) state.inventory = state.inventory.filter(i => i.id !== invId);

    if (item.add && item.addAmt > 0 && getSettings().addictionEnabled) {
      state.addictions[item.add] = Math.min(100, (state.addictions[item.add] || 0) + item.addAmt);
      state.lastUse[item.add]    = Date.now();
    }

    state.txLog.unshift({ ts: Date.now(), type: 'use', desc: `Применено: ${item.name}`, amount: 0 });

    await ctx().saveMetadata();
    updateFabBadge(state);
    await updateAddictionPrompt();
    renderShopContent();

    showToast(`${item.icon} <b>${escHtml(item.name)}</b> применён<br><span style="font-size:11px;opacity:.75">Эффект активен до следующего ответа</span>`, 'effect', 5000);
  }

  // ── Consume effect ────────────────────────────────────────────────────────

  function consumeEffect() {
    if (!effectActive) return;
    effectActive = false;
    try { ctx().setExtensionPrompt(EFFECT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
  }

  // ── Addiction prompt ──────────────────────────────────────────────────────

  async function updateAddictionPrompt() {
    const s = getSettings();
    if (!s.addictionEnabled) {
      try { ctx().setExtensionPrompt(ADDICTION_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
      return;
    }

    const state  = await getChatState();
    const now    = Date.now();
    const HOUR   = 3600000;
    const lines  = [];

    for (const [type, def] of Object.entries(ADDICTION_DEFS)) {
      const level = state.addictions[type] || 0;
      if (level <= 0) continue;
      const hoursSince = (now - (state.lastUse[type] || 0)) / HOUR;

      if (level >= (s.withdrawalThreshold || 40) && hoursSince > 8) {
        lines.push(def.cravingEffect);
      } else if (level >= 20 && hoursSince > 2) {
        lines.push(def.mildEffect);
      }
    }

    const text = lines.join('\n');
    try { ctx().setExtensionPrompt(ADDICTION_TAG, text, EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
  }

  // ── Earn coins ────────────────────────────────────────────────────────────

  async function earnCoins() {
    const s = getSettings();
    if (!s.earnEnabled || !s.earnPerMsg) return;
    const state = await getChatState(true);
    state.balance += s.earnPerMsg;
    state.txLog.unshift({ ts: Date.now(), type: 'earn', desc: 'Монеты за сообщение', amount: s.earnPerMsg });
    await ctx().saveMetadata();
    updateFabBadge(state);
  }

  // ── FAB ───────────────────────────────────────────────────────────────────

  function getFabSize() {
    const sc = getSettings().fabScale ?? 0.9;
    return { W: Math.round(58 * sc) + 10, H: Math.round(50 * sc) + 6 };
  }

  function clampFab(l, t) {
    const { W, H } = getFabSize();
    return {
      l: clamp(l, FAB_MARGIN, Math.max(FAB_MARGIN, vpW() - W - FAB_MARGIN)),
      t: clamp(t, FAB_MARGIN, Math.max(FAB_MARGIN, vpH() - H - FAB_MARGIN)),
    };
  }

  function saveFabPos(l, t) {
    const { W, H } = getFabSize();
    const p  = clampFab(l, t);
    const rx = Math.max(1, vpW() - W - FAB_MARGIN * 2);
    const ry = Math.max(1, vpH() - H - FAB_MARGIN * 2);
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        x: (p.l - FAB_MARGIN) / rx,
        y: (p.t - FAB_MARGIN) / ry,
        l: p.l, t: p.t,
      }));
    } catch {}
  }

  function applyFabPos() {
    const el = document.getElementById('bms_fab');
    if (!el) return;
    el.style.transform = 'none';
    el.style.right = el.style.bottom = 'auto';
    const { W, H } = getFabSize();
    try {
      const raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) { setFabDefault(); return; }
      const pos = JSON.parse(raw);
      const l = typeof pos.x === 'number'
        ? Math.round(pos.x * (vpW() - W - FAB_MARGIN * 2)) + FAB_MARGIN : pos.l;
      const t = typeof pos.y === 'number'
        ? Math.round(pos.y * (vpH() - H - FAB_MARGIN * 2)) + FAB_MARGIN : pos.t;
      const c = clampFab(l, t);
      el.style.left = c.l + 'px';
      el.style.top  = c.t + 'px';
    } catch { setFabDefault(); }
  }

  function setFabDefault() {
    const el = document.getElementById('bms_fab');
    if (!el) return;
    const { W, H } = getFabSize();
    const l = clamp(vpW() - W - FAB_MARGIN - 90, FAB_MARGIN, vpW() - W - FAB_MARGIN);
    const t = clamp(Math.round((vpH() - H) / 2) + 100, FAB_MARGIN, vpH() - H - FAB_MARGIN);
    el.style.left = l + 'px';
    el.style.top  = t + 'px';
    saveFabPos(l, t);
  }

  function applyFabScale() {
    const btn = document.getElementById('bms_fab_btn');
    if (!btn) return;
    const sc = getSettings().fabScale ?? 0.9;
    btn.style.transform       = `scale(${sc})`;
    btn.style.transformOrigin = 'top left';
    const fab = document.getElementById('bms_fab');
    if (fab) {
      fab.style.width  = Math.round(58 * sc) + 'px';
      fab.style.height = Math.round(50 * sc) + 'px';
    }
  }

  function ensureFab() {
    if (document.getElementById('bms_fab')) return;
    const div = document.createElement('div');
    div.id = 'bms_fab';
    div.innerHTML = `
      <button type="button" id="bms_fab_btn" title="Чёрный рынок">
        <div class="bms-fab-icon">💀</div>
        <div class="bms-fab-sub"><span id="bms_fab_coins">500</span>💰</div>
      </button>
      <button type="button" id="bms_fab_hide" title="Скрыть виджет">✕</button>
    `;
    document.body.appendChild(div);

    document.getElementById('bms_fab_btn').addEventListener('click', ev => {
      if (Date.now() - lastFabDragTs < 350) { ev.preventDefault(); return; }
      toggleShop();
    });

    document.getElementById('bms_fab_hide').addEventListener('click', async () => {
      getSettings().showFab = false;
      ctx().saveSettingsDebounced();
      await renderFab();
      showToast('Виджет скрыт — включить в настройках расширения', 'info');
    });

    initFabDrag();
    applyFabPos();
    applyFabScale();
  }

  function initFabDrag() {
    const fab    = document.getElementById('bms_fab');
    const handle = document.getElementById('bms_fab_btn');
    if (!fab || !handle || fab.dataset.drag === '1') return;
    fab.dataset.drag = '1';

    let sx, sy, sl, st, moved = false;
    const THRESH = 6;

    const onMove = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > THRESH) {
        moved = true;
        fab.classList.add('bms-dragging');
      }
      if (!moved) return;
      const p = clampFab(sl + dx, st + dy);
      fab.style.left = p.l + 'px';
      fab.style.top  = p.t + 'px';
      fab.style.right = fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };

    const onEnd = ev => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup',    onEnd);
      document.removeEventListener('pointercancel', onEnd);
      if (moved) {
        saveFabPos(parseInt(fab.style.left) || 0, parseInt(fab.style.top) || 0);
        lastFabDragTs = Date.now();
      }
      moved = false;
      fab.classList.remove('bms-dragging');
    };

    handle.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const { W, H } = getFabSize();
      const curL = parseInt(fab.style.left) || (vpW() - W - FAB_MARGIN - 90);
      const curT = parseInt(fab.style.top)  || Math.round((vpH() - H) / 2);
      const p = clampFab(curL, curT);
      fab.style.left = p.l + 'px'; fab.style.top = p.t + 'px';
      fab.style.right = fab.style.bottom = 'auto'; fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY; sl = p.l; st = p.t; moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup',    onEnd, { passive: true });
      document.addEventListener('pointercancel', onEnd, { passive: true });
      ev.preventDefault();
    }, { passive: false });

    let resizeT = null;
    const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(applyFabPos, 200); };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  }

  async function renderFab() {
    ensureFab();
    applyFabPos();
    applyFabScale();
    const s = getSettings();
    const fab = document.getElementById('bms_fab');
    if (!fab) return;
    if (!s.enabled || !s.showFab) { fab.style.display = 'none'; return; }
    fab.style.display = '';
    const state = await getChatState();
    updateFabBadge(state);
  }

  function updateFabBadge(state) {
    const el = document.getElementById('bms_fab_coins');
    if (el) el.textContent = Math.floor(state.balance);
  }

  // ── Shop modal ────────────────────────────────────────────────────────────

  function ensureShopModal() {
    if (document.getElementById('bms_modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'bms_overlay';
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeShop(); });
    document.body.appendChild(overlay);

    const modal = document.createElement('div');
    modal.id = 'bms_modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="bms-modal-header">
        <div class="bms-modal-title">
          <span class="bms-skull-title">💀</span>
          <span>ЧЁРНЫЙ РЫНОК</span>
        </div>
        <div class="bms-header-right">
          <div class="bms-balance-pill" id="bms_balance_display">💰 500</div>
          <button class="bms-modal-close" id="bms_modal_close" title="Закрыть">✕</button>
        </div>
      </div>

      <div class="bms-tabs-row">
        <button class="bms-tab active" data-tab="shop">🛒 Магазин</button>
        <button class="bms-tab"        data-tab="inventory">🎒 Инвентарь</button>
        <button class="bms-tab"        data-tab="addictions">💉 Зависимости</button>
      </div>

      <div class="bms-modal-body" id="bms_body"></div>
    `;
    document.body.appendChild(modal);

    document.getElementById('bms_modal_close').addEventListener('click', closeShop);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && shopOpen) closeShop(); });

    modal.querySelectorAll('.bms-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.bms-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.getAttribute('data-tab');
        renderShopContent();
      });
    });
  }

  async function toggleShop() {
    if (shopOpen) { closeShop(); return; }
    shopOpen = true;
    ensureShopModal();
    const overlay = document.getElementById('bms_overlay');
    const modal   = document.getElementById('bms_modal');
    if (overlay) overlay.classList.add('bms-overlay-open');
    if (modal)   { modal.classList.add('bms-modal-open'); modal.setAttribute('aria-hidden', 'false'); }
    await renderShopContent();
  }

  function closeShop() {
    shopOpen = false;
    document.getElementById('bms_overlay')?.classList.remove('bms-overlay-open');
    const modal = document.getElementById('bms_modal');
    if (modal) { modal.classList.remove('bms-modal-open'); modal.setAttribute('aria-hidden', 'true'); }
  }

  async function renderShopContent() {
    const state = await getChatState(true);
    const balEl = document.getElementById('bms_balance_display');
    if (balEl) balEl.textContent = fmtCoins(state.balance);
    updateFabBadge(state);

    const body = document.getElementById('bms_body');
    if (!body) return;

    if (activeTab === 'shop') {
      body.innerHTML = renderShopTabHtml(state);
      bindShopEvents();
    } else if (activeTab === 'inventory') {
      body.innerHTML = renderInventoryTabHtml(state);
      bindInventoryEvents();
    } else {
      body.innerHTML = renderAddictionsTabHtml(state);
      bindAddictionsEvents();
    }
  }

  // ── Shop tab ──────────────────────────────────────────────────────────────

  function renderShopTabHtml(state) {
    const invMap = {};
    for (const inv of state.inventory) invMap[inv.itemId] = (invMap[inv.itemId] || 0) + inv.qty;

    const catBar = CATEGORIES.map(c => `
      <button class="bms-cat-btn${activeCat === c.id ? ' bms-cat-active' : ''}" data-cat="${c.id}">
        <span class="bms-cat-icon">${c.icon}</span>
        <span class="bms-cat-name">${c.name}</span>
      </button>`).join('');

    const items = ITEMS.filter(i => i.cat === activeCat);
    const cards = items.map(item => {
      const owned   = invMap[item.id] || 0;
      const canBuy  = state.balance >= item.price;
      const addDef  = item.add ? ADDICTION_DEFS[item.add] : null;
      return `
        <div class="bms-item-card${canBuy ? '' : ' bms-cant-buy'}">
          <div class="bms-item-head">
            <span class="bms-item-icon">${item.icon}</span>
            <div class="bms-item-meta">
              <div class="bms-item-name">${escHtml(item.name)}</div>
              ${addDef ? `<div class="bms-item-addictive">⚠️ зависимость</div>` : ''}
            </div>
            ${owned > 0 ? `<div class="bms-owned-badge">×${owned}</div>` : ''}
          </div>
          <div class="bms-item-desc">${escHtml(item.desc)}</div>
          <div class="bms-item-footer">
            <div class="bms-item-price${canBuy ? '' : ' bms-price-red'}">
              ${item.price} 💰
            </div>
            <div class="bms-qty-row">
              <button class="bms-qty-btn" data-dir="-1" data-item="${item.id}">−</button>
              <span class="bms-qty-val" id="bms_qty_${item.id}">1</span>
              <button class="bms-qty-btn" data-dir="1"  data-item="${item.id}">+</button>
            </div>
            <button class="bms-buy-btn${canBuy ? '' : ' bms-btn-disabled'}"
                    data-item="${item.id}" ${canBuy ? '' : 'disabled'}>
              Купить
            </button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="bms-cat-bar-wrap">
        <div class="bms-cat-bar">${catBar}</div>
      </div>
      <div class="bms-items-grid">
        ${cards || '<div class="bms-empty">Нет товаров</div>'}
      </div>`;
  }

  function bindShopEvents() {
    const body = document.getElementById('bms_body');
    if (!body) return;

    body.querySelectorAll('.bms-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCat = btn.getAttribute('data-cat');
        renderShopContent();
      });
    });

    body.querySelectorAll('.bms-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const itemId = btn.getAttribute('data-item');
        const dir    = parseInt(btn.getAttribute('data-dir'));
        const el     = document.getElementById(`bms_qty_${itemId}`);
        if (!el) return;
        el.textContent = Math.max(1, Math.min(99, (parseInt(el.textContent) || 1) + dir));
      });
    });

    body.querySelectorAll('.bms-buy-btn:not(.bms-btn-disabled)').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.getAttribute('data-item');
        const qty    = parseInt(document.getElementById(`bms_qty_${itemId}`)?.textContent) || 1;
        await buyItem(itemId, qty);
      });
    });
  }

  // ── Inventory tab ─────────────────────────────────────────────────────────

  function renderInventoryTabHtml(state) {
    if (!state.inventory.length) {
      return `
        <div class="bms-empty-inv">
          <div class="bms-empty-inv-icon">🎒</div>
          <div class="bms-empty-inv-text">Инвентарь пуст<br><span>Купи что-нибудь в магазине</span></div>
        </div>`;
    }

    const rows = state.inventory.map(inv => {
      const item = ITEMS.find(i => i.id === inv.itemId);
      if (!item) return '';
      const cat = CATEGORIES.find(c => c.id === item.cat);
      return `
        <div class="bms-inv-row">
          <div class="bms-inv-icon">${item.icon}</div>
          <div class="bms-inv-info">
            <div class="bms-inv-name">${escHtml(item.name)}</div>
            <div class="bms-inv-cat">${cat?.icon || ''} ${escHtml(cat?.name || '')}</div>
            <div class="bms-inv-desc">${escHtml(item.desc)}</div>
          </div>
          <div class="bms-inv-right">
            <div class="bms-inv-qty">×${inv.qty}</div>
            <button class="bms-apply-btn" data-invid="${inv.id}">⚡ Применить</button>
            <button class="bms-discard-btn" data-invid="${inv.id}" title="Выбросить">🗑</button>
          </div>
        </div>`;
    }).join('');

    const totalItems = state.inventory.reduce((s, i) => s + i.qty, 0);

    return `
      <div class="bms-inv-header">
        <span>🎒 Инвентарь</span>
        <span class="bms-inv-count">${totalItems} предметов</span>
      </div>
      ${effectActive ? '<div class="bms-effect-active-banner">⚡ Эффект активен — ждём ответа бота</div>' : ''}
      <div class="bms-inv-list">${rows}</div>`;
  }

  function bindInventoryEvents() {
    const body = document.getElementById('bms_body');
    if (!body) return;

    body.querySelectorAll('.bms-apply-btn').forEach(btn => {
      btn.addEventListener('click', async () => { await applyItem(btn.getAttribute('data-invid')); });
    });

    body.querySelectorAll('.bms-discard-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const state = await getChatState(true);
        const inv   = state.inventory.find(i => i.id === btn.getAttribute('data-invid'));
        const item  = inv ? ITEMS.find(i => i.id === inv.itemId) : null;
        state.inventory = state.inventory.filter(i => i.id !== btn.getAttribute('data-invid'));
        await ctx().saveMetadata();
        renderShopContent();
        showToast(`🗑 ${item ? escHtml(item.name) : 'Предмет'} выброшен`, 'info');
      });
    });
  }

  // ── Addictions tab ────────────────────────────────────────────────────────

  function renderAddictionsTabHtml(state) {
    const getLevelLabel = v => {
      if (v <= 0)  return { text: 'Чисто',          cls: 'clean'    };
      if (v <= 20) return { text: 'Лёгкая привычка', cls: 'mild'     };
      if (v <= 40) return { text: 'Зависимость',     cls: 'moderate' };
      if (v <= 70) return { text: 'Сильная тяга',    cls: 'strong'   };
      return               { text: '⚠️ КРИТИЧНО',    cls: 'critical' };
    };

    const bars = Object.entries(ADDICTION_DEFS).map(([type, def]) => {
      const level     = state.addictions[type] || 0;
      const pct       = Math.min(100, level);
      const lbl       = getLevelLabel(level);
      const lastUseTs = state.lastUse?.[type];
      const since     = lastUseTs
        ? `${Math.floor((Date.now() - lastUseTs) / 3600000)} ч назад`
        : 'никогда';

      return `
        <div class="bms-add-row">
          <div class="bms-add-top">
            <span class="bms-add-icon">${def.icon}</span>
            <span class="bms-add-name">${escHtml(def.name)}</span>
            <span class="bms-add-badge bms-add-${lbl.cls}">${lbl.text}</span>
          </div>
          <div class="bms-add-bar-wrap">
            <div class="bms-add-bar-fill bms-fill-${lbl.cls}" style="width:${pct}%"></div>
          </div>
          <div class="bms-add-meta">
            <span>${level}/100</span>
            <span>последний раз: ${since}</span>
          </div>
          ${level > 0
            ? `<button class="bms-add-reduce-btn" data-type="${type}">↓ Снизить на 15</button>`
            : ''}
        </div>`;
    }).join('');

    return `
      <div class="bms-add-wrap">
        ${bars}
        <div class="bms-add-info">
          <b>💡 Как работают зависимости:</b><br>
          Каждое употребление увеличивает уровень. При уровне &gt;${getSettings().withdrawalThreshold || 40}
          и долгом перерыве — бот получает скрытые инструкции о ломке/тяге.
          При уровне &gt;20 через 2+ часа — лёгкие симптомы фонят в ответах.
        </div>
      </div>`;
  }

  function bindAddictionsEvents() {
    const body = document.getElementById('bms_body');
    if (!body) return;
    body.querySelectorAll('.bms-add-reduce-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type  = btn.getAttribute('data-type');
        const state = await getChatState(true);
        state.addictions[type] = Math.max(0, (state.addictions[type] || 0) - 15);
        await ctx().saveMetadata();
        await updateAddictionPrompt();
        renderShopContent();
        showToast(`📉 ${ADDICTION_DEFS[type]?.name} снижена на 15`, 'info');
      });
    });
  }

  // ── Settings panel ────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if (document.getElementById('bms_settings_block')) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[BMS] settings container not found'); return; }

    const s     = getSettings();
    const state = await getChatState(true);

    const secState = (() => { try { return JSON.parse(localStorage.getItem('bms_sec') || '{}'); } catch { return {}; } })();
    const saveSec  = () => { try { localStorage.setItem('bms_sec', JSON.stringify(secState)); } catch {} };

    const sec = (id, icon, title, content, defOpen = false) => {
      const open = secState[id] !== undefined ? secState[id] : defOpen;
      return `
        <div class="bms-sec" id="bms_sec_${id}">
          <div class="bms-sec-hdr" data-sec="${id}">
            <span class="bms-sec-chev">${open ? '▾' : '▸'}</span>${icon} ${title}
          </div>
          <div class="bms-sec-body"${open ? '' : ' style="display:none"'}>${content}</div>
        </div>`;
    };

    const secMain = `
      <div class="bms-2col">
        <label class="bms-ck"><input type="checkbox" id="bms_enabled" ${s.enabled?'checked':''}><span>Расширение активно</span></label>
        <label class="bms-ck"><input type="checkbox" id="bms_show_fab" ${s.showFab?'checked':''}><span>Виджет 💀</span></label>
        <label class="bms-ck"><input type="checkbox" id="bms_earn_enabled" ${s.earnEnabled?'checked':''}><span>Зарабатывать монеты</span></label>
        <label class="bms-ck"><input type="checkbox" id="bms_add_enabled" ${s.addictionEnabled?'checked':''}><span>Зависимости</span></label>
      </div>
      <div class="bms-srow bms-slider-row">
        <label>Размер кнопки:</label>
        <input type="range" id="bms_scale" min="0.5" max="1.5" step="0.1" value="${s.fabScale ?? 0.9}">
        <span id="bms_scale_val">${Math.round((s.fabScale ?? 0.9) * 100)}%</span>
      </div>
      <div class="bms-compact-btns">
        <button class="menu_button" id="bms_open_shop_btn">💀 Открыть магазин</button>
        <button class="menu_button" id="bms_reset_pos_btn">↺ Позиция кнопки</button>
      </div>`;

    const secWallet = `
      <div class="bms-srow">
        <label>Баланс сейчас:</label>
        <b id="bms_s_balance" style="color:#f5a623;font-size:13px">${Math.floor(state.balance)} 💰</b>
      </div>
      <div class="bms-srow">
        <label>Начальный баланс:</label>
        <input type="number" id="bms_start_balance" min="0" max="999999"
          value="${s.startBalance || 500}"
          style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid rgba(245,166,35,.35);background:rgba(10,8,5,.9);color:#f5a623;font-weight:700;text-align:center">
      </div>
      <div class="bms-srow bms-slider-row">
        <label>Монет за сообщение:</label>
        <input type="range" id="bms_earn_per_msg" min="0" max="100" step="5" value="${s.earnPerMsg || 10}">
        <span id="bms_earn_val">${s.earnPerMsg || 10}</span>
      </div>
      <div class="bms-compact-btns" style="flex-wrap:wrap">
        <button class="menu_button" id="bms_add_100">+100 💰</button>
        <button class="menu_button" id="bms_add_500">+500 💰</button>
        <button class="menu_button" id="bms_add_1000">+1000 💰</button>
      </div>
      <div style="display:flex;gap:5px;margin-top:6px">
        <input type="number" id="bms_custom_amt" min="1" max="999999" placeholder="Своя сумма…"
          style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(245,166,35,.2);background:rgba(10,8,5,.8);color:#f5a623;font-size:12px">
        <button class="menu_button" id="bms_add_custom">+ Добавить</button>
      </div>`;

    const secAddictions = `
      <div class="bms-srow bms-slider-row">
        <label>Порог ломки:</label>
        <input type="range" id="bms_withdraw_thresh" min="20" max="80" step="5" value="${s.withdrawalThreshold || 40}">
        <span id="bms_withdraw_val">${s.withdrawalThreshold || 40}</span>
      </div>
      <div class="bms-compact-btns">
        <button class="menu_button" id="bms_reset_all_add">🔄 Сбросить все зависимости</button>
      </div>`;

    $(target).append(`
      <div class="bms-settings-block" id="bms_settings_block">
        <div class="bms-settings-title">
          <span>💀 Чёрный рынок</span>
          <button type="button" id="bms_collapse_btn">${s.collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="bms-settings-body"${s.collapsed ? ' style="display:none"' : ''}>
          ${sec('main',  '⚙️', 'Основное',   secMain,       true)}
          ${sec('wallet','💰', 'Кошелёк',     secWallet,     false)}
          ${sec('addic', '💉', 'Зависимости', secAddictions, false)}
        </div>
      </div>
    `);

    // Accordion
    $(document).off('click.bms_sec').on('click.bms_sec', '.bms-sec-hdr', function () {
      const id   = this.getAttribute('data-sec');
      const body = $(this).next('.bms-sec-body');
      const open = body.is(':visible');
      body.toggle(!open);
      $(this).find('.bms-sec-chev').text(open ? '▸' : '▾');
      secState[id] = !open; saveSec();
    });

    $('#bms_collapse_btn').on('click', () => {
      s.collapsed = !s.collapsed;
      $('#bms_settings_block .bms-settings-body').toggle(!s.collapsed);
      $('#bms_collapse_btn').text(s.collapsed ? '▸' : '▾');
      ctx().saveSettingsDebounced();
    });

    // Checkboxes
    $('#bms_enabled').on('input',       ev => { s.enabled = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#bms_show_fab').on('input', async ev => { s.showFab = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await renderFab(); });
    $('#bms_earn_enabled').on('input',  ev => { s.earnEnabled = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#bms_add_enabled').on('input', async ev => { s.addictionEnabled = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await updateAddictionPrompt(); });

    // Scale slider
    $('#bms_scale').on('input', ev => {
      const v = parseFloat($(ev.currentTarget).val());
      s.fabScale = v; $('#bms_scale_val').text(Math.round(v * 100) + '%');
      ctx().saveSettingsDebounced(); applyFabScale(); applyFabPos();
    });

    // Wallet
    $('#bms_start_balance').on('input', ev => { s.startBalance = parseInt($(ev.currentTarget).val()) || 500; ctx().saveSettingsDebounced(); });
    $('#bms_earn_per_msg').on('input',  ev => { const v = +$(ev.currentTarget).val(); s.earnPerMsg = v; $('#bms_earn_val').text(v); ctx().saveSettingsDebounced(); });
    $('#bms_withdraw_thresh').on('input', ev => { const v = +$(ev.currentTarget).val(); s.withdrawalThreshold = v; $('#bms_withdraw_val').text(v); ctx().saveSettingsDebounced(); });

    const addBalance = async amount => {
      const state = await getChatState(true);
      state.balance += amount;
      state.txLog.unshift({ ts: Date.now(), type: 'add', desc: 'Пополнение баланса', amount });
      await ctx().saveMetadata();
      updateFabBadge(state);
      $('#bms_s_balance').text(Math.floor(state.balance) + ' 💰');
      showToast(`+${amount} 💰 добавлено!`, 'success');
    };

    $('#bms_add_100').on('click',  () => addBalance(100));
    $('#bms_add_500').on('click',  () => addBalance(500));
    $('#bms_add_1000').on('click', () => addBalance(1000));
    $('#bms_add_custom').on('click', async () => {
      const v = parseInt($('#bms_custom_amt').val()) || 0;
      if (v > 0) { await addBalance(v); $('#bms_custom_amt').val(''); }
    });

    $('#bms_reset_all_add').on('click', async () => {
      const state = await getChatState(true);
      state.addictions = { drugs: 0, alcohol: 0, violence: 0, sex: 0 };
      state.lastUse    = {};
      await ctx().saveMetadata();
      await updateAddictionPrompt();
      showToast('🔄 Все зависимости сброшены', 'info');
    });

    $('#bms_open_shop_btn').on('click', () => toggleShop());
    $('#bms_reset_pos_btn').on('click', () => {
      try { localStorage.removeItem(FAB_POS_KEY); } catch {}
      setFabDefault();
      showToast('Позиция кнопки сброшена', 'info');
    });
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab(); applyFabPos(); applyFabScale();
      await mountSettingsUi();
      await renderFab();
      await updateAddictionPrompt();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      effectActive = false;
      try { ctx().setExtensionPrompt(EFFECT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
      await renderFab();
      await updateAddictionPrompt();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
      consumeEffect();
      await updateAddictionPrompt();
      if (shopOpen && activeTab === 'inventory') await renderShopContent();
    });

    eventSource.on(event_types.MESSAGE_SENT, async () => {
      await earnCoins();
      await updateAddictionPrompt();
      if (shopOpen) {
        const state = await getChatState();
        const balEl = document.getElementById('bms_balance_display');
        if (balEl) balEl.textContent = fmtCoins(state.balance);
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  jQuery(() => {
    try {
      wireChatEvents();
      console.log('[BMS] Чёрный рынок v1.0.0 загружен');
    } catch (e) {
      console.error('[BMS] init failed', e);
    }
  });

})();
