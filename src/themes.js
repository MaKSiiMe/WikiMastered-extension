// Règles des étiquettes de thème, reprises du bot WikiMastered (config/themes.yaml, même format en JSON) : une carte
// reçoit chaque thème dont une règle correspond à ce que Wikidata dit de son article (src/lib.js, themesOf).
//   classes      classes Wikidata : l'article en est un exemple ou une sous-classe (Q5 : être humain)
//   taxa         taxons Wikidata : l'espèce en descend (Q729 : animaux)
//   words        pour les personnes : un mot de la description Wikidata (fr) commence par l'un de ceux-ci ; 4 lettres
//                ou moins : le mot exact ; avec une espace ou un tiret : l'expression entière
//   occupations  pour les personnes sans description : métiers Wikidata (P106)
//   unless       pas ce thème si la carte a déjà l'un de ceux-là (ne retire pas un thème trouvé par la description)
//   alone        seulement si la carte n'a aucun autre thème
//   removable    retiré d'une carte qui n'a plus ce thème, une fois un autre de ses thèmes posé
//   emoji, color nom et couleur de l'étiquette quand l'extension la crée sur le site
// corrections : titre -> thèmes, à la place de Wikidata. Changer classes, taxa ou occupations : monter VERSION (tout
// est reclassé au passage suivant).
const WME_THEMES = {
 "themes": [
  {
   "name": "Personne",
   "classes": [
    "Q5"
   ],
   "color": "#3b82f6"
  },
  {
   "name": "Pays",
   "classes": [
    "Q6256",
    "Q3624078"
   ],
   "color": "#14532d"
  },
  {
   "name": "Lieu",
   "classes": [
    "Q486972",
    "Q56061",
    "Q41176",
    "Q811979",
    "Q4989906",
    "Q570116",
    "Q22698",
    "Q33506",
    "Q5107",
    "Q23442",
    "Q39614",
    "Q79007"
   ],
   "unless": [
    "Pays",
    "Histoire"
   ],
   "color": "#f97316"
  },
  {
   "name": "Nature",
   "classes": [
    "Q8502",
    "Q4022",
    "Q23397",
    "Q9430",
    "Q8514",
    "Q8072",
    "Q271669",
    "Q15324",
    "Q7946"
   ],
   "taxa": [
    "Q756",
    "Q764"
   ],
   "unless": [
    "Pays",
    "Lieu",
    "Histoire",
    "Animal",
    "Spatial",
    "Nourriture / Boisson"
   ],
   "color": "#22c55e"
  },
  {
   "name": "Animal",
   "classes": [
    "Q39367",
    "Q26401003"
   ],
   "taxa": [
    "Q729"
   ],
   "unless": [
    "Personne"
   ],
   "color": "#78350f"
  },
  {
   "name": "Astéroïde",
   "classes": [
    "Q3863",
    "Q1022867"
   ],
   "color": "#a5b4fc"
  },
  {
   "name": "Spatial",
   "classes": [
    "Q634",
    "Q523",
    "Q318",
    "Q8928",
    "Q2537",
    "Q3559",
    "Q42372",
    "Q40218",
    "Q26529",
    "Q26540",
    "Q2133344",
    "Q55818"
   ],
   "occupations": [
    "Q11631"
   ],
   "unless": [
    "Astéroïde"
   ],
   "words": [
    "astronaute",
    "cosmonaute",
    "spationaute",
    "taïkonaute"
   ],
   "color": "#4f46e5"
  },
  {
   "name": "Cinéma / Série",
   "classes": [
    "Q11424",
    "Q24856",
    "Q5398426",
    "Q3464665",
    "Q15416",
    "Q581714",
    "Q1107",
    "Q95074",
    "Q196600"
   ],
   "occupations": [
    "Q33999",
    "Q2526255",
    "Q28389"
   ],
   "unless": [
    "Jeu vidéo",
    "Littérature / BD",
    "Religion"
   ],
   "words": [
    "acteur",
    "actrice",
    "comédien",
    "réalisateur",
    "réalisatrice",
    "cinéaste",
    "doubleu",
    "scénariste",
    "producteur de cinéma",
    "productrice de cinéma",
    "producteur de télévision",
    "animateur de télévision",
    "animatrice de télévision"
   ],
   "color": "#ef4444"
  },
  {
   "name": "Musique",
   "classes": [
    "Q7366",
    "Q134556",
    "Q482994",
    "Q105543609",
    "Q215380",
    "Q2088357",
    "Q34379",
    "Q188451",
    "Q868557",
    "Q1344"
   ],
   "occupations": [
    "Q639669",
    "Q177220",
    "Q2252262",
    "Q36834",
    "Q130857"
   ],
   "words": [
    "chanteu",
    "rappeu",
    "musicien",
    "compositeu",
    "interprète",
    "pianiste",
    "guitariste",
    "batteu",
    "violoniste",
    "bassiste",
    "violoncelliste",
    "saxophoniste",
    "trompettiste",
    "organiste",
    "flûtiste",
    "harpiste",
    "dj",
    "disc-jockey",
    "beatmaker",
    "producteur de musique",
    "chef d'orchestre",
    "parolier",
    "parolière",
    "auteur-compositeur",
    "autrice-compositrice"
   ],
   "color": "#a855f7"
  },
  {
   "name": "Sport",
   "classes": [
    "Q349",
    "Q847017",
    "Q12973014",
    "Q13406554",
    "Q16510064",
    "Q5389",
    "Q623109",
    "Q1076486",
    "Q483110"
   ],
   "occupations": [
    "Q2066131",
    "Q378622",
    "Q41583",
    "Q16029547"
   ],
   "words": [
    "footballeu",
    "joueu",
    "athlète",
    "sporti",
    "cycliste",
    "coureu",
    "nageu",
    "boxeu",
    "tennism",
    "rugby",
    "handballeu",
    "basketteu",
    "volleyeu",
    "judoka",
    "karatéka",
    "skieu",
    "patineu",
    "gymnaste",
    "escrimeu",
    "lutteu",
    "golfeu",
    "surfeu",
    "arts martiaux",
    "entraîneu",
    "entraineu",
    "sélectionneu",
    "arbitre",
    "pilote automobile",
    "pilote de formule",
    "pilote de course",
    "pilote de rallye",
    "pilote moto",
    "motocycliste",
    "triathlète",
    "marathonien",
    "sprinteu",
    "alpiniste",
    "haltérophile",
    "décathlonien",
    "heptathlonienne",
    "catcheu",
    "skateu",
    "pongiste",
    "biathlète",
    "skipper",
    "skippeuse",
    "navigat",
    "rameu",
    "céiste",
    "kayakiste",
    "fondeu",
    "bobeur",
    "bobeuse",
    "lugeu",
    "curleu",
    "archer",
    "archère",
    "tireur sportif",
    "tireuse sportive",
    "cavalier",
    "cavalière",
    "grimpeu",
    "plongeu",
    "water-polo",
    "hockeye",
    "badiste",
    "snooker",
    "fléchettes",
    "culturiste",
    "taekwondo"
   ],
   "color": "#84cc16"
  },
  {
   "name": "Jeu vidéo",
   "classes": [
    "Q7889",
    "Q7058673",
    "Q8076",
    "Q1569167",
    "Q210167"
   ],
   "words": [
    "joueur professionnel de jeux vidéo",
    "joueuse professionnelle de jeux vidéo",
    "créateur de jeux vidéo",
    "concepteur de jeux vidéo"
   ],
   "color": "#0891b2"
  },
  {
   "name": "Littérature / BD",
   "classes": [
    "Q7725634",
    "Q571",
    "Q8261",
    "Q1004",
    "Q21198342",
    "Q8274",
    "Q1114461",
    "Q87576284",
    "Q1092563",
    "Q11032",
    "Q41298",
    "Q2085381"
   ],
   "occupations": [
    "Q36180",
    "Q6625963",
    "Q49757",
    "Q1930187",
    "Q4964182",
    "Q715301"
   ],
   "unless": [
    "Jeu vidéo",
    "Musique",
    "Science"
   ],
   "words": [
    "écrivain",
    "romancier",
    "romancière",
    "poète",
    "poétesse",
    "dramaturge",
    "essayiste",
    "nouvelliste",
    "auteur de bande dessinée",
    "autrice de bande dessinée",
    "dessinateur de bande dessinée",
    "mangaka",
    "bédéiste",
    "journaliste",
    "éditeur",
    "éditrice",
    "philosophe",
    "traducteu",
    "biographe",
    "chroniqueu",
    "pamphlétaire",
    "fabuliste",
    "critique littéraire"
   ],
   "color": "#c2410c"
  },
  {
   "name": "Art",
   "classes": [
    "Q3305213",
    "Q860861",
    "Q179700",
    "Q968159"
   ],
   "occupations": [
    "Q1028181",
    "Q1281618",
    "Q33231",
    "Q42973",
    "Q644687"
   ],
   "unless": [
    "Lieu",
    "Littérature / BD",
    "Cinéma / Série",
    "Musique"
   ],
   "words": [
    "peintre",
    "sculpteu",
    "photographe",
    "architecte",
    "graveu",
    "illustrateu",
    "dessinateur",
    "dessinatrice",
    "artiste",
    "plasticien",
    "calligraphe",
    "affichiste",
    "caricaturiste",
    "céramiste",
    "styliste",
    "couturier",
    "couturière",
    "designer",
    "chorégraphe",
    "danseur",
    "danseuse"
   ],
   "color": "#d81b60"
  },
  {
   "name": "Science",
   "classes": [
    "Q11862829",
    "Q11173",
    "Q11344",
    "Q8054",
    "Q7187",
    "Q12136",
    "Q169872",
    "Q4936952",
    "Q3918",
    "Q38723",
    "Q3914",
    "Q31855",
    "Q65943",
    "Q11563"
   ],
   "occupations": [
    "Q901",
    "Q170790",
    "Q169470",
    "Q593644",
    "Q864503",
    "Q39631",
    "Q11063",
    "Q201788",
    "Q81096"
   ],
   "unless": [
    "Nature",
    "Animal",
    "Technologie"
   ],
   "words": [
    "scientifique",
    "chercheu",
    "mathématicien",
    "physicien",
    "chimiste",
    "biologiste",
    "médecin",
    "chirurgien",
    "astronome",
    "astrophysicien",
    "botaniste",
    "zoologiste",
    "géologue",
    "paléontologue",
    "archéologue",
    "historien",
    "sociologue",
    "économiste",
    "linguiste",
    "psychologue",
    "psychiatre",
    "neurologue",
    "anthropologue",
    "ethnologue",
    "géographe",
    "universitaire",
    "académicien",
    "inventeu",
    "ingénieu",
    "informaticien",
    "pharmacien",
    "vétérinaire",
    "épistémologue"
   ],
   "color": "#0d9488"
  },
  {
   "name": "Politique",
   "classes": [
    "Q7278",
    "Q40231",
    "Q178790",
    "Q484652"
   ],
   "occupations": [
    "Q82955",
    "Q193391",
    "Q116",
    "Q2478141",
    "Q16533",
    "Q40348"
   ],
   "unless": [
    "Pays",
    "Entreprise / Marque",
    "Sport",
    "Musique",
    "Science",
    "Religion"
   ],
   "words": [
    "homme politique",
    "femme politique",
    "personnalité politique",
    "homme d'état",
    "femme d'état",
    "chef d'état",
    "président",
    "premier ministre",
    "première ministre",
    "ministre",
    "député",
    "sénateur",
    "sénatrice",
    "maire",
    "gouverneu",
    "diplomate",
    "ambassadeu",
    "ambassadrice",
    "monarque",
    "roi",
    "reine",
    "empereur",
    "impératrice",
    "prince",
    "princesse",
    "duc",
    "duchesse",
    "comte",
    "comtesse",
    "marquis",
    "marquise",
    "baron",
    "baronne",
    "seigneur",
    "aristocrate",
    "noble",
    "pharaon",
    "sultan",
    "calife",
    "émir",
    "tsar",
    "tsarine",
    "militant",
    "révolutionnaire",
    "syndicaliste",
    "magistrat",
    "juge",
    "avocat"
   ],
   "color": "#881337"
  },
  {
   "name": "Militaire",
   "classes": [
    "Q176799",
    "Q728",
    "Q15142894",
    "Q64418",
    "Q12876",
    "Q177597",
    "Q2811",
    "Q559026",
    "Q216916",
    "Q1785071"
   ],
   "occupations": [
    "Q47064",
    "Q189290"
   ],
   "words": [
    "militaire",
    "général",
    "amiral",
    "maréchal",
    "officier",
    "colonel",
    "commandant",
    "capitaine",
    "lieutenant",
    "soldat",
    "guerrier",
    "guerrière",
    "résistant",
    "chevalier",
    "mercenaire",
    "aviateur militaire",
    "as de l'aviation"
   ],
   "color": "#991b1b"
  },
  {
   "name": "Religion",
   "classes": [
    "Q9174",
    "Q179461",
    "Q178885",
    "Q20643955",
    "Q4271324",
    "Q16970",
    "Q2977",
    "Q32815",
    "Q44539",
    "Q160742",
    "Q44613"
   ],
   "occupations": [
    "Q250867",
    "Q42603",
    "Q29182",
    "Q1234713"
   ],
   "words": [
    "prélat",
    "évêque",
    "archevêque",
    "cardinal",
    "pape",
    "prêtre",
    "abbé",
    "moine",
    "religieu",
    "pasteur",
    "rabbin",
    "imam",
    "théologien",
    "missionnaire",
    "saint",
    "martyr",
    "prophète",
    "prédicateu",
    "mystique"
   ],
   "color": "#8d6e63"
  },
  {
   "name": "Transport",
   "classes": [
    "Q55488",
    "Q55678",
    "Q928830",
    "Q728937",
    "Q1248784",
    "Q12280",
    "Q34442",
    "Q11436",
    "Q11446",
    "Q93301",
    "Q870",
    "Q46970"
   ],
   "unless": [
    "Voiture",
    "Militaire",
    "Spatial",
    "Histoire"
   ],
   "words": [
    "aviateu",
    "aviatrice"
   ],
   "color": "#0284c7"
  },
  {
   "name": "Nourriture / Boisson",
   "classes": [
    "Q2095",
    "Q746549",
    "Q19861951",
    "Q40050",
    "Q154",
    "Q958314"
   ],
   "words": [
    "cuisinier",
    "cuisinière",
    "chef cuisinier",
    "cheffe cuisinière",
    "pâtissier",
    "pâtissière",
    "œnologue"
   ],
   "color": "#fde047"
  },
  {
   "name": "Entreprise / Marque",
   "classes": [
    "Q4830453",
    "Q431289",
    "Q786820"
   ],
   "occupations": [
    "Q131524",
    "Q43845"
   ],
   "unless": [
    "Science",
    "Transport",
    "Jeu vidéo",
    "Littérature / BD"
   ],
   "words": [
    "entrepreneur",
    "entrepreneuse",
    "homme d'affaires",
    "femme d'affaires",
    "industriel",
    "dirigeant d'entreprise",
    "chef d'entreprise",
    "cheffe d'entreprise",
    "banquier",
    "banquière",
    "milliardaire",
    "investisseu",
    "armateur"
   ],
   "color": "#64748b"
  },
  {
   "name": "Voiture",
   "classes": [
    "Q3231690",
    "Q59773381",
    "Q1420",
    "Q786820"
   ],
   "color": "#1e3a8a"
  },
  {
   "name": "Technologie",
   "classes": [
    "Q11016",
    "Q7397",
    "Q9143",
    "Q9135",
    "Q35127",
    "Q3220391",
    "Q68",
    "Q17517",
    "Q22645",
    "Q5082128",
    "Q15328",
    "Q313600",
    "Q5362345",
    "Q19799938"
   ],
   "unless": [
    "Jeu vidéo",
    "Voiture",
    "Transport",
    "Militaire"
   ],
   "color": "#22d3ee"
  },
  {
   "name": "Objet",
   "classes": [
    "Q8205328",
    "Q39546",
    "Q1183543",
    "Q11460",
    "Q14745",
    "Q11422"
   ],
   "alone": true,
   "removable": true,
   "color": "#b6a99a"
  },
  {
   "name": "Histoire",
   "classes": [
    "Q13418847",
    "Q178561",
    "Q198",
    "Q645883",
    "Q10931",
    "Q131569",
    "Q41397",
    "Q48349",
    "Q164950",
    "Q3024240",
    "Q8432",
    "Q11514315",
    "Q839954",
    "Q852190"
   ],
   "color": "#d4a373"
  },
  {
   "name": "Année",
   "classes": [
    "Q577",
    "Q29964144",
    "Q18340514",
    "Q47150325",
    "Q47018478",
    "Q39911"
   ],
   "emoji": "🗓️",
   "color": "#99f6e4"
  },
  {
   "name": "Liste",
   "classes": [
    "Q13406463"
   ],
   "unless": [
    "Année"
   ],
   "emoji": "📋",
   "color": "#d9f99d"
  },
  {
   "name": "Nom",
   "classes": [
    "Q101352",
    "Q202444",
    "Q8436"
   ],
   "emoji": "🏷️",
   "color": "#c026d3"
  },
  {
   "name": "Homonymie",
   "classes": [
    "Q4167410"
   ],
   "emoji": "🔀",
   "color": "#94a3b8"
  },
  {
   "name": "Football",
   "classes": [
    "Q476028",
    "Q26887310"
   ],
   "words": [
    "footballeu"
   ],
   "emoji": "🥅",
   "color": "#4d7c0f"
  },
  {
   "name": "Film",
   "classes": [
    "Q11424"
   ],
   "emoji": "📽️",
   "color": "#fca5a5"
  },
  {
   "name": "Plante",
   "taxa": [
    "Q756"
   ],
   "emoji": "🌱",
   "color": "#86efac"
  },
  {
   "name": "Insecte / Araignée",
   "taxa": [
    "Q1360"
   ],
   "emoji": "🕷️",
   "color": "#d97706"
  },
  {
   "name": "Royauté / Noblesse",
   "words": [
    "roi",
    "reine",
    "empereur",
    "impératrice",
    "pharaon",
    "prince",
    "monarque",
    "sultan",
    "tsar",
    "souverain",
    "régent",
    "calife",
    "khan",
    "shah",
    "duc",
    "duchesse",
    "archiduc",
    "comte",
    "vicomte",
    "marquis",
    "baron",
    "noble",
    "aristocrate",
    "seigneur",
    "landgrave",
    "margrave"
   ],
   "emoji": "👑",
   "color": "#5b21b6"
  },
  {
   "name": "Personnage de fiction",
   "classes": [
    "Q95074",
    "Q4271324"
   ],
   "emoji": "🦸",
   "color": "#2563eb"
  }
 ],
 "corrections": {
  "Ingrid Alexandra de Norvège": [
   "Personne",
   "Politique"
  ],
  "Marteau": [
   "Objet"
  ],
  "Blockchain": [
   "Technologie"
  ],
  "Bitcoin": [
   "Technologie"
  ],
  "Analyse PESTEL": [
   "Entreprise / Marque"
  ],
  "Ballon d'or 2021": [
   "Sport"
  ],
  "(505476) 2013 UL15": [
   "Astéroïde"
  ],
  "Julia Kourotchkina": [
   "Personne"
  ],
  "Nedeljko Čabrinović": [
   "Personne"
  ],
  "Kikkuli": [
   "Personne"
  ],
  "Yuán Chónghuàn": [
   "Personne",
   "Militaire"
  ],
  "Umm Hakim bint Abdul Muttalib": [
   "Personne",
   "Religion"
  ],
  "Arwa bint Kurayz": [
   "Personne",
   "Religion"
  ]
 }
};
WME_THEMES.VERSION = 1;
