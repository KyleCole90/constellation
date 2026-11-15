export interface AuthoredAssignment {
  key: string;
  course: "eng10" | "bio" | "hist" | "art";
  title: string;
  shortTitle: string;
  pointsPossible: number;
  rubric: readonly { name: string; maxPoints: number }[];
}
type AuthoredWork =
  | { kind: "text"; paragraphs: readonly string[] }
  | { kind: "pdf"; file: string }
  | { kind: "image"; file: string }
  | { kind: "link-screenshot"; url: string; file: string }
  | { kind: "document"; file: string };
export interface AuthoredSubmission {
  id: string;
  student: string;
  assignment: string;
  work: AuthoredWork;
}

export const ASSIGNMENTS: readonly AuthoredAssignment[] = [
  {
    key: "eng-argument",
    course: "eng10",
    title: "Argumentative Essay: A Policy Your School or Town Should Change",
    shortTitle: "Argument Essay",
    pointsPossible: 40,
    rubric: [
      { name: "Claim and focus", maxPoints: 10 },
      { name: "Evidence and reasoning", maxPoints: 12 },
      { name: "Counterargument", maxPoints: 8 },
      { name: "Organization and conventions", maxPoints: 10 },
    ],
  },
  {
    key: "eng-poetry",
    course: "eng10",
    title: "Poetry Analysis: A Close Reading of a Poem from the Unit",
    shortTitle: "Poetry Analysis",
    pointsPossible: 30,
    rubric: [
      { name: "Interpretation", maxPoints: 12 },
      { name: "Textual evidence", maxPoints: 10 },
      { name: "Writing", maxPoints: 8 },
    ],
  },
  {
    key: "eng-response",
    course: "eng10",
    title: "Reading Response: Of Mice and Men",
    shortTitle: "Reading Response",
    pointsPossible: 20,
    rubric: [
      { name: "Insight", maxPoints: 8 },
      { name: "Use of the text", maxPoints: 6 },
      { name: "Voice and clarity", maxPoints: 6 },
    ],
  },
  {
    key: "bio-lab",
    course: "bio",
    title: "Lab Report: Catalase Activity and Temperature",
    shortTitle: "Catalase Lab",
    pointsPossible: 50,
    rubric: [
      { name: "Question and hypothesis", maxPoints: 10 },
      { name: "Method", maxPoints: 10 },
      { name: "Data and analysis", maxPoints: 15 },
      { name: "Conclusion and error", maxPoints: 10 },
      { name: "Format", maxPoints: 5 },
    ],
  },
  {
    key: "bio-poster",
    course: "bio",
    title: "Cell Processes Visual: Explain One Process to a Freshman",
    shortTitle: "Cell Process Visual",
    pointsPossible: 20,
    rubric: [
      { name: "Scientific accuracy", maxPoints: 10 },
      { name: "Labels and vocabulary", maxPoints: 5 },
      { name: "Design and clarity", maxPoints: 5 },
    ],
  },
  {
    key: "bio-notebook",
    course: "bio",
    title: "Pond Survey Field Notebook",
    shortTitle: "Pond Notebook",
    pointsPossible: 20,
    rubric: [
      { name: "Observations", maxPoints: 8 },
      { name: "Data", maxPoints: 6 },
      { name: "Reflection", maxPoints: 6 },
    ],
  },
  {
    key: "hist-dbq",
    course: "hist",
    title: "DBQ: Did Industrialization Improve American Workers' Lives, 1865 to 1900?",
    shortTitle: "Gilded Age DBQ",
    pointsPossible: 30,
    rubric: [
      { name: "Thesis", maxPoints: 6 },
      { name: "Use of documents", maxPoints: 10 },
      { name: "Outside evidence", maxPoints: 6 },
      { name: "Analysis and sourcing", maxPoints: 8 },
    ],
  },
  {
    key: "hist-exhibit",
    course: "hist",
    title: "Digital Exhibit: A Local Industry",
    shortTitle: "Local Industry Exhibit",
    pointsPossible: 20,
    rubric: [
      { name: "Research", maxPoints: 8 },
      { name: "Design", maxPoints: 6 },
      { name: "Sources", maxPoints: 6 },
    ],
  },
  {
    key: "art-portrait",
    course: "art",
    title: "Self-Portrait with Artist Statement",
    shortTitle: "Self-Portrait",
    pointsPossible: 25,
    rubric: [
      { name: "Technique", maxPoints: 10 },
      { name: "Composition", maxPoints: 8 },
      { name: "Artist statement", maxPoints: 7 },
    ],
  },
  {
    key: "art-statement",
    course: "art",
    title: "Artist Statement: Self-Portrait Project",
    shortTitle: "Artist Statement",
    pointsPossible: 20,
    rubric: [
      { name: "Describes the work", maxPoints: 5 },
      { name: "Explains choices and intent", maxPoints: 8 },
      { name: "Reflection", maxPoints: 4 },
      { name: "Writing", maxPoints: 3 },
    ],
  },
];

export const SUBMISSIONS: readonly AuthoredSubmission[] = [
  {
    id: "maya-argument",
    student: "Maya Okonkwo",
    assignment: "eng-argument",
    work: {
      kind: "text",
      paragraphs: [
        "At 6:10 every school morning my alarm goes off, and every morning I lose an argument with my own body. I am not lazy, and I am not alone. Sleep researchers have spent two decades documenting a plain fact about teenagers: our body clocks shift later at puberty, so falling asleep before eleven is biologically hard. Because of that, high schools should start no earlier than 8:30 a.m.",
        "The strongest evidence comes from schools that have already changed. In a 2018 study of two Seattle high schools, the start time moved from 7:50 to 8:45. Students slept about 34 minutes more per night, and median grades rose by roughly four percent. Those are not small numbers for a change that costs no classroom time. The American Academy of Pediatrics has recommended an 8:30 start since 2014, and it describes chronic sleep loss in teenagers as a public health issue, linked to depression, obesity and car crashes.",
        "Opponents raise real objections, and the loudest is logistics. Buses are often shared between elementary, middle and high schools, so moving one bell moves them all. That is a scheduling problem, though, and scheduling problems have solutions. Districts can flip the order so that the youngest children, who wake early anyway, start first and teenagers start last. Some districts even save money by trimming the number of routes. A cost that can be engineered away is not a reason to keep harming students.",
        "A second objection is that later dismissal squeezes sports, jobs and family time. I take this seriously, because I work Saturdays and my brother plays soccer. But a practice that ends at 5:45 instead of 4:30 is an inconvenience, while a student who is half asleep in third period is losing the main thing school exists to give. If we must trade, we should trade the thing that is easier to move. Practices can be rescheduled; adolescent biology cannot.",
        "Starting school later is not about giving teenagers an easier life. It is about matching the day to the way our brains actually work. The research is consistent, the pilot programs worked, and the obstacles are logistical rather than educational. Districts that still ring the first bell at 7:15 are choosing habit over evidence, and students are the ones paying for it.",
      ],
    },
  },
  {
    id: "dylan-argument",
    student: "Dylan Reyes",
    assignment: "eng-argument",
    work: {
      kind: "text",
      paragraphs: [
        "Should school start later? I think yes, it should. Alot of students are tired in the morning and everyone knows that teenagers need more sleep then adults. If school started at nine or even 8:30 students would be more awake and get better grades. This essay will explain why I think that.",
        "First of all, sleep is important. Studies show that teenagers need around 9 hours of sleep every night, but most of us only get about 6 or 7. When you do not get enough sleep your brain does not work well and its hard to pay attention in class. I know in my first period class half the people are on their phones or have their heads down on the desk. A later start would give us more time to sleep and then we would be able to focus on what the teacher is saying.",
        "Second, a later start might help with attendance. If students are not rushing to catch the bus they will be on time more often, so there would be less tardies. Some schools that tried this saw less students skipping first period. Teachers would also be happier because students would be more awake and the class would go smoother.",
        "Some people say that a later start would be bad for sports and after school jobs. This is true but I think the benefits is bigger than the problems. Also the coaches could just start practice later. In conclusion, schools should start later because students need sleep, it will help grades and attendance, and everyone would be happier.",
      ],
    },
  },
  {
    id: "priya-argument",
    student: "Priya Nair",
    assignment: "eng-argument",
    work: {
      kind: "text",
      paragraphs: [
        "School starts too early. Everybody agrees on that. My school starts at 7:30 which is crazy because I wake up at 6:00 and that is basically the middle of the night. Teenagers need twelve hours of sleep to be healthy so waking up that early is not good for us at all. I think the school board should change it because they obviously do not care about students. Last week I fell asleep in math and Mr. Kline sent me to the office, which was embarrassing, and it was not even my fault because I was up late finishing a project.",
        "Another thing is homework. Teachers give so much homework that I do not get done until almost midnight. Then I have to get up at 6:00. So I think the real problem is homework and not just school start times. If teachers gave less homework we would not need to sleep so late. Also phones are a big problem because everybody stays up on TikTok and Instagram and that is why people are tired. Social media companies make the apps addicting on purpose and the government should do something about it.",
        "In conclusion school should start later and also teachers should give less homework and phones should be banned. Then students would be happy and get more sleep. Some people say that schools cant change the time because of buses but I think they can just get more buses. My cousin goes to a school in another state and they start at 9:00 and he says it is way better, so it works. That is my argument and I hope that the school board reads it.",
      ],
    },
  },
  {
    id: "jonah-poetry",
    student: "Jonah Whitfield",
    assignment: "eng-poetry",
    work: {
      kind: "text",
      paragraphs: [
        "On the surface, Robert Frost's 'Stopping by Woods on a Snowy Evening' is a small story: a traveler pauses on a dark road to watch snow fall into a forest, then drives on. But the poem keeps pressing on that simple pause, and by its last line the quiet woods have become a question about rest, duty and how much of a life we owe to other people. I read the woods as a temptation toward surrender, even toward death, and I will argue that Frost builds that tension through sound, repetition and the speaker's own self-correction.",
        "The first evidence is the speaker's attitude toward the woods. They are 'lovely, dark and deep,' a phrase in which the adjectives pull in opposite directions. Lovely invites him in; dark and deep warn him off. The horse, meanwhile, 'must think it queer' to stop 'without a farmhouse near.' Frost gives the practical voice to the animal, which lets the speaker keep his own longing private. The shake of the harness bells is the only sound besides 'the sweep / Of easy wind and downy flake,' and it works like an alarm for the speaker's conscience.",
        "The rhyme scheme carries the argument too. Each stanza rhymes AABA, and the unrhymed third line of one stanza becomes the rhyme for the next, linking the poem like a chain. The chain breaks only at the end, where all four lines of the last stanza rhyme. This feels like a person sinking into the snow, and then the repetition arrives: 'And miles to go before I sleep, / And miles to go before I sleep.' The first time, the line is literal, because he has a journey. The second time, 'sleep' sounds like something larger, and the repetition reads like a man talking himself into continuing.",
        "The poem's genius is that it never says what the woods are. Frost leaves the speaker in the exact moment between wanting to stop and choosing not to. The 'promises to keep' are not named either, which makes them heavier. Some readers might say that I am overreading a winter ride, and that sometimes a snowy evening is only a snowy evening. But the careful sound structure and the poem's slow darkening make that reading hard to sustain. Frost wants us to feel the pull and the promise at the same time.",
      ],
    },
  },
  {
    id: "lucia-poetry",
    student: "Lucia Brandt",
    assignment: "eng-poetry",
    work: {
      kind: "text",
      paragraphs: [
        "In the poem 'Stopping by Woods on a Snowy Evening' by Robert Frost, the speaker stops his horse near a forest on the darkest night of the year to watch the snow fall. The poem is about a man who finds the woods beautiful but remembers that he has a long way to go. I think the main theme is that people have responsibilities even when they want to rest.",
        "Frost uses a lot of imagery to show the setting. He says the woods are 'lovely, dark and deep' which makes you picture a quiet forest. The snow is 'downy flake' which sounds soft like a pillow. There is also personification when the horse gives his harness bells a shake 'to ask if there is some mistake.' This makes the horse seem like a person who is worried about the speaker. The poem also has a rhyme scheme that is AABA which makes it sound like a song.",
        "The ending is the most important part. The speaker says 'miles to go before I sleep' two times. This repetition shows that he is determined to keep going. Sleep might mean death, but it also could just mean going to bed. In conclusion, Frost shows that even though nature is peaceful, we have to do what we promised. The poem is a good example of how a simple scene can have a deeper meaning. I liked this poem because it is short but still makes you think, and it reminded me of driving home late at night when everything is quiet and the roads are empty.",
      ],
    },
  },
  {
    id: "theo-dbq",
    student: "Theo Hargrove",
    assignment: "hist-dbq",
    work: {
      kind: "text",
      paragraphs: [
        "Between 1865 and 1900 the United States became the largest industrial economy in the world, but the benefits of that growth did not reach workers evenly or quickly. Industrialization raised average wages and made goods cheaper, yet it also brought dangerous factories, long hours and a loss of control over work. On balance, industrialization improved workers' material lives only to a limited extent, and workers had to organize to secure even those gains.",
        "Document A, a table of average annual earnings, shows that real wages for nonfarm workers rose by about a quarter between 1870 and 1900. This supports the claim that industrial work paid better than the farm labor many migrants left behind. However, the table averages skilled and unskilled workers together, so it hides the fact that unskilled laborers, including many recent immigrants, earned far less than the mean. Document B, Andrew Carnegie's 'Gospel of Wealth,' argues that concentrated wealth was beneficial because rich men would use it for the common good. Carnegie's point of view matters: he was among the richest industrialists, so he had every reason to defend a system that enriched him.",
        "Documents C and D complicate that picture. Lewis Hine's photograph of young children working in a textile mill (Document C) shows that cheap manufactured goods depended partly on child labor, and its purpose was to persuade reformers, not to record an average day. Document D, a Knights of Labor circular, demands an eight-hour day, which tells us that ordinary workdays were much longer. Taken together, these documents suggest that higher pay came with serious costs in safety and time.",
        "Outside evidence confirms that workers fought for change and often lost. In the Homestead Strike of 1892, Carnegie Steel locked out its union workers and brought in Pinkerton guards, and the union was broken even though the company's profits were large. The Pullman Strike of 1894 ended when federal troops were sent in. These examples show that employers and the government often sided against workers, which supports the argument that gains were limited. Still, the later growth of the American Federation of Labor shows that organized workers eventually found a way to bargain for better terms.",
      ],
    },
  },
  {
    id: "amara-dbq",
    student: "Amara Singh",
    assignment: "hist-dbq",
    work: {
      kind: "text",
      paragraphs: [
        "Industrialization is when factories started making everything instead of people making things by hand. This happened in the 1700s with Henry Ford and the assembly line. In the Gilded Age, factories were making cars and everyone was getting rich. Workers were happy because they had jobs and the factories were making progress for the country. My great grandpa worked in a factory and he never complained about it once, so I think the workers were mostly fine.",
        "Document B is by Andrew Carnegie who was the president of the United States for a while and he says that rich people should give money away. This shows that workers were treated well. Today it is a lot like Amazon where workers pack boxes in warehouses and there are robots. Jeff Bezos is like Carnegie because he is rich and he also gives away money. Amazon workers have to pee in bottles which is bad but they get paid more than minimum wage so it is okay. I also saw a documentary about it.",
        "So to conclude industrialization improved the lives of workers a lot because they got jobs and cheap products. Some people didnt like it but they were just lazy. The Gilded Age was a time of great progress and the workers benefitted a lot. Without industrialization we would not have phones or cars or anything so it was a good thing for everybody. People today should be thankful for the factories, because the Gilded Age is the reason our country is so powerful and rich and why we have so many jobs.",
      ],
    },
  },
  {
    id: "noor-dbq",
    student: "Noor Haddad",
    assignment: "hist-dbq",
    work: {
      kind: "text",
      paragraphs: [
        "The Industrial Revolution in America changed many things for workers. Some of the changes were good and some were bad. I think industrialization improved the lives of workers a little bit but there were also many problems, so the answer is mixed.",
        "One good thing was that wages went up. Document A shows that earnings went up from 1870 to 1900. This means that workers could buy more things. Also, factories made products cheaper so more people could afford them. Andrew Carnegie says in Document B that rich people help society by giving money to libraries and schools, and he gave away a lot of money himself.",
        "However, there were many bad things. In Document C, the photograph shows children working in a factory which is dangerous and not fair. Document D says workers wanted an eight hour day which means they were working very long hours. Many workers also lived in crowded tenements in cities like New York. There were strikes such as the Homestead Strike. Workers wanted better pay and safer conditions, but they did not always get it.",
        "In conclusion, industrialization helped workers by raising wages and lowering prices, but it hurt them with long hours, child labor and dangerous conditions. So to a moderate extent it improved their lives. I think the good and the bad were about equal, but the factories did help the country grow. If I had to pick one more reason, I would say that the unions were important because they gave workers a voice and made employers listen, and that is a lasting effect that we still see today.",
      ],
    },
  },
  {
    id: "caleb-lab",
    student: "Caleb Moreno",
    assignment: "bio-lab",
    work: {
      kind: "text",
      paragraphs: [
        "Question and hypothesis. We wanted to know how temperature affects the activity of catalase, the enzyme in liver that breaks down hydrogen peroxide into water and oxygen. My hypothesis was that catalase would work fastest at room temperature or a little warmer and slower in the cold and the hot, because enzymes have an optimum temperature and heat can denature them.",
        "Method. We cut a cube of chicken liver (about 1 cm) for each trial and dropped it in a test tube with 5 mL of 3% hydrogen peroxide that had been held in a water bath at 5, 20, 37 or 60 degrees C for five minutes. We measured the height of the foam in the test tube after 60 seconds with a ruler. Each temperature was tested 3 times. The independent variable was temperature and the dependent variable was foam height. We kept the liver size, the volume of peroxide and the time the same.",
        "Results. The average foam heights were 1.2 cm at 5 C, 3.8 cm at 20 C, 5.9 cm at 37 C and 0.4 cm at 60 C. At 60 C the liver turned gray and there was almost no foam. The three trials at 37 C were close together (5.5, 6.0 and 6.2 cm) but the trials at 20 C varied more (3.1, 3.6 and 4.7).",
        "Conclusion. My hypothesis was partly right. Catalase was slower in the cold and nearly stopped in the heat, which fits the idea that high temperature denatures the enzyme's shape so the substrate no longer fits the active site. But the fastest rate was at 37 C and not at room temperature, which I did not expect. This makes sense because the liver comes from an animal whose body temperature is close to 37 C. Sources of error were that the liver cubes were cut by hand so they were not exactly the same size, and the foam could spill over the edge of the tube. Next time we should use a balance to mass each piece of liver and test more temperatures between 37 and 60 to find where the enzyme stops working.",
      ],
    },
  },
  {
    id: "ingrid-response",
    student: "Ingrid Solheim",
    assignment: "eng-response",
    work: {
      kind: "text",
      paragraphs: [
        "Reading the first three chapters of Of Mice and Men, I kept noticing how often George and Lennie talk about a place that doesn't exist yet. The farm with the rabbits is repeated almost like a bedtime story, and Lennie asks George to tell it again each time he is nervous. I think the dream works less like a plan and more like a comfort, something they hold on to because the world they actually live in is lonely.",
        "Steinbeck makes the loneliness clear even in chapter 1, when George says that guys like ranch hands are 'the loneliest guys in the world.' They have no family and no place of their own. That makes George and Lennie unusual, because they 'got each other.' What surprised me is how tired George sounds, though. He complains that he could live easy without Lennie, but then he describes just what he would do and it sounds hollow. The complaint is a kind of love, in a gruff way.",
        "The part I'm still thinking about is the dead mouse. Lennie keeps a mouse in his pocket and pets it, and George throws it away because it's dead and Lennie will only hurt it. It seems small, but it shows that Lennie does not know his own strength, and it hints that something worse is coming. I also wonder if I'm supposed to feel sorry for Lennie or be a little afraid of him. Right now it's both, and I think that's intentional.",
        "Overall, the book makes me care about two men with almost nothing, and it's already making me nervous for them. Next I want to watch how the dream changes once other people on the ranch start believing in it too.",
      ],
    },
  },
  {
    id: "wen-lab",
    student: "Wen Zhao",
    assignment: "bio-lab",
    work: { kind: "pdf", file: "lab-report-wen.pdf" },
  },
  {
    id: "sofia-lab",
    student: "Sofia Marchetti",
    assignment: "bio-lab",
    work: { kind: "pdf", file: "lab-report-sofia.pdf" },
  },
  {
    id: "ethan-argument",
    student: "Ethan Park",
    assignment: "eng-argument",
    work: { kind: "pdf", file: "argument-essay-ethan.pdf" },
  },
  {
    id: "hannah-argument",
    student: "Hannah Bell",
    assignment: "eng-argument",
    work: { kind: "pdf", file: "argument-essay-hannah.pdf" },
  },
  {
    id: "marcus-dbq",
    student: "Marcus Teller",
    assignment: "hist-dbq",
    work: { kind: "pdf", file: "dbq-marcus.pdf" },
  },
  {
    id: "zara-poetry",
    student: "Zara Ali",
    assignment: "eng-poetry",
    work: { kind: "pdf", file: "poetry-analysis-zara.pdf" },
  },
  {
    id: "owen-dbq",
    student: "Owen Castillo",
    assignment: "hist-dbq",
    work: { kind: "pdf", file: "dbq-owen.pdf" },
  },
  {
    id: "leah-poetry",
    student: "Leah Fischer",
    assignment: "eng-poetry",
    work: { kind: "pdf", file: "poetry-analysis-leah.pdf" },
  },
  {
    id: "ravi-poster",
    student: "Ravi Desai",
    assignment: "bio-poster",
    work: { kind: "image", file: "photosynthesis-poster-ravi.png" },
  },
  {
    id: "isabel-poster",
    student: "Isabel Cruz",
    assignment: "bio-poster",
    work: { kind: "image", file: "mitosis-diagram-isabel.png" },
  },
  {
    id: "felix-poster",
    student: "Felix Aarons",
    assignment: "bio-poster",
    work: { kind: "image", file: "respiration-infographic-felix.png" },
  },
  {
    id: "kai-lab",
    student: "Kai Tanaka",
    assignment: "bio-lab",
    work: { kind: "image", file: "lab-data-sheet-kai.png" },
  },
  {
    id: "lena-portrait",
    student: "Lena Vogel",
    assignment: "art-portrait",
    work: { kind: "image", file: "self-portrait-lena.png" },
  },
  {
    id: "diego-portrait",
    student: "Diego Ramos",
    assignment: "art-portrait",
    work: { kind: "image", file: "self-portrait-diego.png" },
  },
  {
    id: "nadia-response",
    student: "Nadia Rahman",
    assignment: "eng-response",
    work: {
      kind: "link-screenshot",
      url: "https://nadiareads.wordpress.com/2026/10/22/george-lennie-and-the-dream-that-isnt-there/",
      file: "blog-post-nadia.png",
    },
  },
  {
    id: "carlos-exhibit",
    student: "Carlos Vega",
    assignment: "hist-exhibit",
    work: {
      kind: "link-screenshot",
      url: "https://carlosvega-history.wixsite.com/riverbend-mill",
      file: "exhibit-site-carlos.png",
    },
  },
  {
    id: "tessa-notebook",
    student: "Tessa Bryant",
    assignment: "bio-notebook",
    work: {
      kind: "link-screenshot",
      url: "https://tessa-bryant.notion.site/Pond-Survey-Field-Notebook-5c1e0a7b3d9f4e82",
      file: "field-notebook-tessa.png",
    },
  },
  {
    id: "mira-portrait",
    student: "Mira Castellano",
    assignment: "art-statement",
    work: { kind: "document", file: "artist-statement-mira.md" },
  },
  {
    id: "jamal-response",
    student: "Jamal Pierce",
    assignment: "eng-response",
    work: { kind: "document", file: "reading-response-jamal.md" },
  },
  {
    id: "elena-dbq",
    student: "Elena Kowalski",
    assignment: "hist-dbq",
    work: { kind: "document", file: "dbq-response-elena.docx" },
  },
];
