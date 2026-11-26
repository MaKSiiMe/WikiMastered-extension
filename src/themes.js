// Règles des étiquettes de thème (onglet Collection) : une carte reçoit chaque thème coché dont une règle correspond à
// ce que Wikidata dit de son article (src/lib.js, themeMatches et pickThemes).
//   classes      classes Wikidata : l'article en est un exemple ou une sous-classe (Q5 : être humain)
//   taxa         taxons Wikidata : l'espèce en descend (Q729 : animaux)
//   words        pour les personnes : un mot de la description Wikidata (fr) commence par l'un de ceux-ci ; 4 lettres
//                ou moins : le mot exact ; avec une espace ou un tiret : l'expression entière
//   occupations  pour les personnes sans description : métiers Wikidata (P106)
//   unless       pas ce thème si la carte a déjà l'un de ceux-là, parmi les thèmes cochés (ne retire pas un thème trouvé
//                par la description : une personne cumule)
//   alone        seulement si la carte n'a aucun autre thème
//   removable    retiré d'une carte qui n'a plus ce thème, une fois un autre de ses thèmes posé
//   emoji, color nom et couleur de l'étiquette quand l'extension la crée sur le site
// corrections : titre -> thèmes, à la place de Wikidata. Changer classes, taxa, occupations ou words : monter VERSION
// (tout est reclassé au passage suivant).
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
   "color": "#f97316"
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
   "name": "Cinéma",
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
    "Littérature"
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
    "Animaux"
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
    "Sport",
    "Musique",
    "Science"
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
   "name": "Animaux",
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
   "name": "Littérature",
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
    "Lieu",
    "Animaux"
   ],
   "color": "#22c55e"
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
    "Littérature",
    "Cinéma",
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
  }
 ],
 "corrections": {
  "Ingrid Alexandra de Norvège": [
   "Personne",
   "Politique"
  ],
  "Ballon d'or 2021": [
   "Sport"
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
   "Personne"
  ],
  "Umm Hakim bint Abdul Muttalib": [
   "Personne"
  ],
  "Arwa bint Kurayz": [
   "Personne"
  ]
 }
};
WME_THEMES.VERSION = 2;
