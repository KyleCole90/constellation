// Hard-coded fake data. Every school detail below the two named instances, every student, and every submission is invented.
// LMS facts only. What the agent would say about them lives in src/shared/agent/rules/drafts.ts.

export interface SeedPiece {
  title: string;
  words: number;
  duration?: string;
  doc: readonly string[];
}
interface SeedPrior {
  grade: number;
  comment: string;
  scores?: Readonly<Record<string, number>>;
}
export interface SeedAssignment {
  id: string;
  short: string;
  title: string;
  due: string;
  pts: number;
  /** One character per student: G graded, N new, L late, R resubmitted, M missing, - not submitted. */
  statuses: string;
  canvasId?: number;
  lateRate?: number;
  kind?: "video";
  lateDays?: Readonly<Record<number, number>>;
  fixedGrades?: Readonly<Record<number, number>>;
  prior?: Readonly<Record<number, SeedPrior>>;
  rubric?: readonly { id: string; name: string; max: number }[];
  pieces?: readonly SeedPiece[];
}
interface SeedThread {
  id: string;
  kind: "grading" | "messages" | "announcement";
  title: string;
  time: string;
  assignmentId?: string;
}
interface SeedMessage {
  id: string;
  from: string;
  subject: string;
  at: string;
  canvasId: number;
  body: string;
  history: readonly { at: string; mine: boolean; text: string }[];
  answer?: { at: string; text: string };
}
interface SeedAnnouncement {
  id: string;
  title: string;
  body: string;
  at: string;
}
export interface SeedCourse {
  id: string;
  schoolId: string;
  code: string;
  title: string;
  section: string;
  canvasId: number;
  students: readonly string[];
  assignments: readonly SeedAssignment[];
  threads: readonly SeedThread[];
  messages: readonly SeedMessage[];
  announcements: readonly SeedAnnouncement[];
}
export interface SeedData {
  now: string;
  instructor: string;
  schools: readonly { id: string; abbr: string; name: string; host: string }[];
  courses: readonly SeedCourse[];
}

export const SEED: SeedData = {
  now: "2026-10-30T11:42",
  instructor: "Kyle",
  schools: [
    {
      id: "lcc",
      abbr: "LCC",
      name: "Lakeshore Community College",
      host: "lakeshore.instructure.com",
    },
    {
      id: "rsu",
      abbr: "RSU",
      name: "Riverbend State University",
      host: "riverbend.instructure.com",
    },
  ],
  courses: [
    {
      id: "eng101",
      schoolId: "lcc",
      code: "ENG 101",
      title: "Composition I",
      section: "sec 04",
      canvasId: 48213,
      students: [
        "Maya Ortiz",
        "Devon Reyes",
        "Priya Raman",
        "Tomasz Wilk",
        "Aaliyah Brooks",
        "Jonah Feld",
        "Keiko Morita",
        "Luis Cardenas",
        "Hannah Stroud",
        "Samir Haddad",
        "Imani Okafor",
        "Caleb Nystrom",
        "Rosa Delgado",
        "Owen Tierney",
      ],
      assignments: [
        {
          id: "e101-rr5",
          short: "Reading Response 5",
          title: "Reading Response 5",
          due: "2026-10-22T23:59",
          pts: 20,
          statuses: "GGGGGGGGGGMGGG",
          fixedGrades: { "13": 12 },
        },
        {
          id: "e101-essay2",
          short: "Essay 2",
          title: "Essay 2: Rhetorical Analysis",
          due: "2026-10-26T23:59",
          pts: 100,
          lateRate: 2.5,
          statuses: "NGNGLGGRNGMGGG",
          lateDays: { "4": 2 },
          canvasId: 310442,
          prior: {
            "7": {
              grade: 58,
              comment:
                "Your summary of the ad is clear, but the essay reports what it says rather than how it persuades. Revise for analysis and resubmit by Oct 29.",
              scores: { thesis: 12, evidence: 15, analysis: 14, mechanics: 17 },
            },
          },
          rubric: [
            { id: "thesis", name: "Thesis and claim", max: 25 },
            { id: "evidence", name: "Evidence from the text", max: 25 },
            { id: "analysis", name: "Rhetorical analysis", max: 30 },
            { id: "mechanics", name: "Organization and mechanics", max: 20 },
          ],
          pieces: [
            {
              title: "The Quiet Sell: How a Bank Ad Borrows Your Grandmother",
              words: 1184,
              doc: [
                "Community Trust Bank's thirty-second spot opens on a kitchen table, a recipe card, and a pair of hands that are clearly not an actor's. Nothing about the first twenty seconds mentions money. I argue that the ad earns trust by delaying its own purpose, using nostalgia as ethos so that the bank's name arrives feeling like something the viewer already believed.",
                'The strongest appeal is visual. The camera stays at table height, which places the viewer in the seat of a child watching someone cook. When the narrator finally says "we remember your name," the line lands as a family claim rather than a marketing claim. The ad never presents evidence of good service. It presents a feeling of having been known.',
                "Some viewers might say the ad is only heartwarming and that I am reading too much into it. However the timing of the logo shows the opposite. The logo appears only after the hands fold the card and put it in a tin, in other words after the ad has finished asking us to feel safe. In conclusion the ad works because it sells memory and lets the bank take the credit for it.",
              ],
            },
            {
              title: "Why the Gym Commercial Yells at You",
              words: 967,
              doc: [
                "The Ironclad Fitness commercial is loud, fast, and aimed at people who feel guilty. In this essay I will talk about pathos, ethos, and logos in the commercial and how the company uses them to get people to sign up for a membership.",
                "Pathos is used when the trainer shouts that excuses are for other people. This makes the viewer feel bad and want to change. Ethos is used because the trainer has big muscles so he looks like he knows what he is talking about. Logos is used when the ad says members lose an average of twelve pounds.",
                "Overall the ad is effective because it uses all three appeals. The twelve pounds statistic has a small footnote at the bottom that you can barely read, which makes me wonder if it is true. I think the company knows most people will not check.",
              ],
            },
          ],
        },
        {
          id: "e101-rr6",
          short: "Reading Response 6",
          title: "Reading Response 6",
          due: "2026-10-29T23:59",
          pts: 20,
          statuses: "GGGGNGGGGGNGG-",
          canvasId: 310451,
          pieces: [
            {
              title: 'Response to "The Case for Slow Reading"',
              words: 312,
              doc: [
                "The author's claim that skimming changes what we can remember surprised me, because I always assumed I was saving time. When I tried reading the article twice, the second pass showed me the part about attention spans was built on one small study. I still agree with the conclusion, but I trust it less than I did the first time.",
              ],
            },
            {
              title: 'Response to "The Case for Slow Reading"',
              words: 241,
              doc: [
                "I agree with the author that people do not read carefully anymore. I see this at my job where nobody reads the schedule. The article made good points and it was easy to follow. I would recommend it to other students because reading slowly is important.",
              ],
            },
          ],
        },
        {
          id: "e101-outline3",
          short: "Essay 3 Outline",
          title: "Essay 3 Outline",
          due: "2026-11-06T23:59",
          pts: 30,
          statuses: "--------------",
        },
      ],
      threads: [
        {
          id: "t-e101-essay2",
          kind: "grading",
          assignmentId: "e101-essay2",
          title: "Grade Essay 2",
          time: "12m",
        },
        { id: "t-e101-mail", kind: "messages", title: "Reply to late-work emails", time: "1h" },
        {
          id: "t-e101-ann",
          kind: "announcement",
          title: "Week 10: Essay 3 starts Monday",
          time: "3h",
        },
        {
          id: "t-e101-rr6",
          kind: "grading",
          assignmentId: "e101-rr6",
          title: "Grade Reading Response 6",
          time: "1d",
        },
      ],
      messages: [
        {
          id: "m-e101-1",
          from: "Imani Okafor",
          subject: "Essay 2 is going to be late",
          canvasId: 90114,
          body: "Hi Professor, I missed Essay 2 because I picked up extra shifts when my brother was in the hospital. Is it still possible to turn it in this weekend? I can send a note from his doctor if you need one.",
          at: "2026-10-29T21:14",
          history: [],
        },
        {
          id: "m-e101-2",
          from: "Aaliyah Brooks",
          subject: "Late penalty question",
          canvasId: 90108,
          body: "I turned my essay in on Wednesday morning, so does that count as two days late or one? The syllabus says 2.5 points per day, just want to make sure I understand.",
          at: "2026-10-29T16:02",
          history: [
            { at: "2026-10-20T10:05", mine: false, text: "Is Essay 2 due at midnight on Monday?" },
            {
              at: "2026-10-20T12:30",
              mine: true,
              text: "Yes, 11:59 PM Monday. Canvas records the time you submit.",
            },
          ],
        },
        {
          id: "m-e101-3",
          from: "Owen Tierney",
          subject: "Can I redo Reading Response 5?",
          canvasId: 90097,
          body: "I got a 12 on Reading Response 5. Can I redo it for a better grade?",
          at: "2026-10-28T19:40",
          history: [
            {
              at: "2026-10-23T08:12",
              mine: false,
              text: "Did my Reading Response 5 go through? I didn't get a confirmation.",
            },
            { at: "2026-10-23T09:40", mine: true, text: "It's in. Feedback will post next week." },
          ],
        },
      ],
      announcements: [
        {
          id: "an-e101-p",
          title: "Essay 2 resubmission window",
          body: "Essay 1 revisions are graded. Essay 2 resubmissions close Oct 29 for anyone who received a revision note.",
          at: "2026-10-26T08:00",
        },
        {
          id: "an-e101-rr",
          title: "How reading responses count",
          body: "Reading responses can't be redone. Your lowest two scores drop at the end of the term.",
          at: "2026-08-31T09:00",
        },
      ],
    },
    {
      id: "eng102",
      schoolId: "lcc",
      code: "ENG 102",
      title: "Composition II",
      section: "sec 11",
      canvasId: 48227,
      students: [
        "Nadia Petrov",
        "Marcus Yoon",
        "Gwen Hollis",
        "Tariq Mansour",
        "Elena Vasquez",
        "Bo Lindqvist",
        "Chloe Ashby",
        "Darnell Pruitt",
        "Farah Siddiqui",
        "Ian McCreedy",
        "Lena Sorensen",
      ],
      assignments: [
        {
          id: "e102-memo",
          short: "Research Question Memo",
          title: "Research Question Memo",
          due: "2026-10-23T23:59",
          pts: 20,
          statuses: "GGGGGGGGGGG",
        },
        {
          id: "e102-bib",
          short: "Annotated Bibliography",
          title: "Annotated Bibliography",
          due: "2026-10-27T23:59",
          pts: 50,
          lateRate: 1,
          canvasId: 310588,
          statuses: "GNGGLGGNGRG",
          lateDays: { "4": 3 },
          prior: {
            "9": {
              grade: 31,
              comment:
                "Three of your sources are press releases. Replace them with peer-reviewed or primary sources and resubmit.",
              scores: { sources: 8, annotations: 13, format: 10 },
            },
          },
          rubric: [
            { id: "sources", name: "Source quality", max: 20 },
            { id: "annotations", name: "Annotation depth", max: 20 },
            { id: "format", name: "MLA format", max: 10 },
          ],
          pieces: [
            {
              title: "Annotated Bibliography: Four-Day School Weeks",
              words: 1420,
              doc: [
                'Anderson, Tess. "Attendance and Achievement in Rural Four-Day Districts." Journal of Education Finance, vol. 47, no. 2, 2022, pp. 118-41. Anderson compares test scores in sixty districts before and after the switch and finds no clear decline. I will use this as my main counter to the claim that shorter weeks hurt learning, though the study only covers rural districts.',
                'Morales, Ivan. "Who Watches the Kids on Friday?" Policy Brief, Center for Family Economics, 2023. Morales looks at childcare costs for working parents. This source complicates my thesis, because it shows that savings for a district can become costs for families. I plan to address it directly in my second section.',
              ],
            },
            {
              title: "Annotated Bibliography: Social Media and Teen Sleep",
              words: 1105,
              doc: [
                'Clarke, Jo. "Screens After Dark." Health Today Online, 2024. This article is about how phones keep teens awake. It says that blue light is a problem and that teens should put their phones away an hour before bed. It is helpful for my paper.',
                'Patel, Reena, et al. "Evening Social Media Use and Sleep Onset in Adolescents." Sleep Health, vol. 9, no. 4, 2023, pp. 402-11. This study surveyed 1,200 students and found later sleep times among heavy evening users. It is helpful because it has data.',
              ],
            },
          ],
        },
        {
          id: "e102-draft",
          short: "Research Paper Draft",
          title: "Research Paper Draft",
          due: "2026-11-05T23:59",
          pts: 100,
          statuses: "-----------",
        },
      ],
      threads: [
        {
          id: "t-e102-bib",
          kind: "grading",
          assignmentId: "e102-bib",
          title: "Grade Annotated Bibliography",
          time: "2h",
        },
        { id: "t-e102-mail", kind: "messages", title: "Reply to source questions", time: "5h" },
        {
          id: "t-e102-ann",
          kind: "announcement",
          title: "Library session next Tuesday",
          time: "1d",
        },
      ],
      messages: [
        {
          id: "m-e102-1",
          from: "Gwen Hollis",
          subject: "Does a podcast count as a source?",
          canvasId: 90120,
          body: "One of the best things I found for my topic is a podcast interview with a researcher. Can I use it for the draft, or does it have to be an article?",
          at: "2026-10-29T13:22",
          history: [
            {
              at: "2026-10-22T14:03",
              mine: false,
              text: "How many sources do we need for the draft?",
            },
            {
              at: "2026-10-22T16:20",
              mine: true,
              text: "At least five, and two of them should be peer-reviewed.",
            },
          ],
        },
        {
          id: "m-e102-2",
          from: "Bo Lindqvist",
          subject: "Library login not working",
          canvasId: 90101,
          body: "The library database keeps asking me for a password that I don't have. Who do I contact?",
          at: "2026-10-28T10:11",
          history: [],
        },
      ],
      announcements: [
        {
          id: "an-e102-p",
          title: "Bibliography rubric posted",
          body: "The rubric for the annotated bibliography is on the assignment page. Sources count for the most points.",
          at: "2026-10-21T15:30",
        },
      ],
    },
    {
      id: "comm110",
      schoolId: "lcc",
      code: "COMM 110",
      title: "Public Speaking",
      section: "sec 02, online",
      canvasId: 48240,
      students: [
        "Jada Whitfield",
        "Emil Novak",
        "Sofia Marchetti",
        "Andre Baptiste",
        "Wren Calloway",
        "Hiro Tanabe",
        "Paige Dunmore",
        "Kofi Mensah",
        "Talia Rosen",
      ],
      assignments: [
        {
          id: "c110-disc",
          short: "Discussion 8",
          title: "Discussion 8: Audience Analysis",
          due: "2026-10-25T23:59",
          pts: 10,
          statuses: "GGGMGGGGG",
        },
        {
          id: "c110-speech2",
          short: "Speech 2",
          title: "Speech 2: Informative (recorded)",
          due: "2026-10-28T23:59",
          pts: 100,
          lateRate: 5,
          kind: "video",
          canvasId: 310702,
          statuses: "NGGLGNGGG",
          lateDays: { "3": 1 },
          rubric: [
            { id: "content", name: "Content and organization", max: 40 },
            { id: "delivery", name: "Vocal and physical delivery", max: 40 },
            { id: "visuals", name: "Visual aid", max: 20 },
          ],
          pieces: [
            {
              title: "How Tap Water Gets to Your Kitchen",
              words: 690,
              duration: "6:42",
              doc: [
                "[0:00] Turn on your faucet. In about three seconds you're drinking water that was in a reservoir eleven days ago. Today I'll walk you through the three stops it makes on the way.",
                "[2:15] The second stop is the treatment plant, and this slide shows the part most people never think about, which is the settling basin. It looks like a very boring swimming pool.",
                "[5:50] So, reservoir, treatment, and the pressure system under your street. Next time you fill a glass, you'll know where it's been.",
              ],
            },
            {
              title: "What Happens to Your Recycling",
              words: 610,
              duration: "5:58",
              doc: [
                "[0:00] Hi everyone, today I'm going to inform you about recycling. Recycling is something that a lot of people do, and there's more to it than you may think.",
                "[1:40] So, um, the truck takes it to a place called a materials recovery facility, and there they sort it. I have a chart here but it's kind of hard to see, sorry about that.",
                "[5:30] So that's recycling. Does anyone, oh wait, this is recorded. Thank you.",
              ],
            },
          ],
        },
        {
          id: "c110-outline3",
          short: "Speech 3 Outline",
          title: "Speech 3 Outline",
          due: "2026-11-03T23:59",
          pts: 20,
          canvasId: 310719,
          statuses: "-N--N----",
          pieces: [
            {
              title: "Outline: Adopt a Storm Drain",
              words: 420,
              doc: [
                "I. Attention: The drain on your street floods because of leaves, not rain. II. Need: Most city drains are cleared by nobody. III. Satisfaction: The adopt-a-drain program takes five minutes a month. IV. Visualization: Your block after the next storm. V. Action: Sign up tonight with the link on my last slide.",
              ],
            },
            {
              title: "Outline: Why You Should Learn CPR",
              words: 365,
              doc: [
                "I. Intro: CPR is important. II. Facts about cardiac arrest. III. Where to take a class. IV. Conclusion: You should learn CPR.",
              ],
            },
          ],
        },
      ],
      threads: [
        {
          id: "t-c110-speech2",
          kind: "grading",
          assignmentId: "c110-speech2",
          title: "Grade Speech 2",
          time: "40m",
        },
        { id: "t-c110-mail", kind: "messages", title: "Reply to recording issues", time: "2h" },
        {
          id: "t-c110-ann",
          kind: "announcement",
          title: "Week 10: Persuasive speaking",
          time: "6h",
        },
        {
          id: "t-c110-outline3",
          kind: "grading",
          assignmentId: "c110-outline3",
          title: "Grade Speech 3 Outline",
          time: "1d",
        },
      ],
      messages: [
        {
          id: "m-c110-1",
          from: "Wren Calloway",
          subject: "My video won't upload",
          canvasId: 90133,
          body: "The upload keeps failing at 90%. It's a 2 GB file from my phone. What should I do? I don't want my next speech to be late.",
          at: "2026-10-30T07:05",
          history: [
            {
              at: "2026-10-27T19:15",
              mine: false,
              text: "Speech 2 finally uploaded after I switched to wifi. Thanks for the tip.",
            },
            {
              at: "2026-10-27T20:02",
              mine: true,
              text: "Glad it worked. Your submission shows on time.",
            },
          ],
        },
        {
          id: "m-c110-2",
          from: "Paige Dunmore",
          subject: "Audience requirement",
          canvasId: 90099,
          body: "Do I need live people in the room for Speech 3, or is it okay to record by myself?",
          at: "2026-10-28T18:30",
          history: [],
        },
      ],
      announcements: [
        {
          id: "an-c110-p",
          title: "Speech 2 recording tips",
          body: "Prop your phone at eye level, record a 20-second sound check, and keep your whole upper body in frame.",
          at: "2026-10-23T09:00",
        },
        {
          id: "an-c110-s3",
          title: "Speech 3 audience and uploads",
          body: "Speech 3 needs an audience of at least three people in the room, visible in at least one wide shot. Family or roommates count. If your video won't upload, post it to your school video account as unlisted and paste the link as a text entry. That counts as on time.",
          at: "2026-10-19T09:00",
        },
      ],
    },
    {
      id: "eng210",
      schoolId: "rsu",
      code: "ENG 210",
      title: "Intro to Literature",
      section: "",
      canvasId: 12077,
      students: [
        "Beatrice Lowell",
        "Mateo Quiroga",
        "Anika Desai",
        "Graham Pell",
        "Zora Tillman",
        "Felix Aronson",
        "Mina Cho",
        "Reuben Castellano",
        "Harper Vance",
        "Yusuf Demir",
        "Clara Engstrom",
        "Nico Barros",
      ],
      assignments: [
        {
          id: "e210-poetry",
          short: "Poetry Response",
          title: "Poetry Response",
          due: "2026-10-20T23:59",
          pts: 25,
          statuses: "GGGGGGGGGGGM",
        },
        {
          id: "e210-close2",
          short: "Close Reading 2",
          title: "Close Reading 2",
          due: "2026-10-29T17:00",
          pts: 100,
          lateRate: 3,
          canvasId: 88213,
          statuses: "GNGGNGGLGGRG",
          lateDays: { "7": 1 },
          prior: {
            "10": {
              grade: 54,
              comment:
                "Good passage choice. You rely on plot summary in the middle two paragraphs. Revise to stay closer to the language.",
              scores: { reading: 19, language: 18, argument: 17 },
            },
          },
          rubric: [
            { id: "reading", name: "Attention to the passage", max: 35 },
            { id: "language", name: "Language and form", max: 35 },
            { id: "argument", name: "Interpretive argument", max: 30 },
          ],
          pieces: [
            {
              title: 'The Door That Stays Open: Reading the Last Page of "The Harbor House"',
              words: 1310,
              doc: [
                `The last page of "The Harbor House" repeats the word "still" four times in nine lines. On a first reading it sounds like calm. Read closely, the word shifts its meaning from motionless to continuing, and that shift is the story's actual ending.`,
                `When the narrator says the door was "still open," the sentence refuses to tell us whether anyone has left. The grammar holds both possibilities. It's the same refusal we saw when the mother "had not yet" answered the letter in the first section.`,
                "I read the ending as a decision the narrator cannot admit to making. Leaving the door open is the only action she takes in the whole story, and the prose describes it as if it happened on its own.",
              ],
            },
            {
              title: 'Family Conflict in "The Harbor House"',
              words: 1045,
              doc: [
                `"The Harbor House" is about a family with a lot of conflict. The mother and daughter don't communicate well, and this causes many problems in the story, especially when the letter arrives.`,
                `In the second section the daughter finds the letter and decides not to tell anyone. This shows that she doesn't trust her mother. Later they argue about the house, and the author writes that the "air went thin," which shows the tension.`,
                "At the end the door is left open, which symbolizes that the family could still communicate someday. This shows the theme that communication is important in families.",
              ],
            },
          ],
        },
        {
          id: "e210-midterm",
          short: "Midterm Paper",
          title: "Midterm Paper",
          due: "2026-11-04T17:00",
          pts: 150,
          statuses: "------------",
        },
      ],
      threads: [
        {
          id: "t-e210-close2",
          kind: "grading",
          assignmentId: "e210-close2",
          title: "Grade Close Reading 2",
          time: "28m",
        },
        { id: "t-e210-mail", kind: "messages", title: "Reply to midterm questions", time: "3h" },
        { id: "t-e210-ann", kind: "announcement", title: "Midterm paper guidelines", time: "1d" },
      ],
      messages: [
        {
          id: "m-e210-1",
          from: "Harper Vance",
          subject: "Midterm paper topic",
          canvasId: 55102,
          body: 'Can I write my midterm paper on two stories instead of one? I think the endings of "The Harbor House" and "Salt Year" are doing the same thing.',
          at: "2026-10-29T20:48",
          history: [
            {
              at: "2026-10-26T11:30",
              mine: false,
              text: "Is a comparison paper allowed for the midterm?",
            },
            {
              at: "2026-10-26T13:45",
              mine: true,
              text: "Possibly. Tell me which works you have in mind.",
            },
          ],
        },
        {
          id: "m-e210-2",
          from: "Yusuf Demir",
          subject: "Class on Tuesday",
          canvasId: 55098,
          body: "I have a required lab trip next Tuesday and will miss class. Is there anything I should do beforehand?",
          at: "2026-10-29T11:15",
          history: [],
        },
      ],
      announcements: [
        {
          id: "an-e210-p",
          title: "Close Reading 2 due Thursday at 5 PM",
          body: "Reminder that this deadline is at 5 PM, not midnight. Bring a printed copy of your passage to class.",
          at: "2026-10-26T07:45",
        },
      ],
    },
    {
      id: "eng305",
      schoolId: "rsu",
      code: "ENG 305",
      title: "Technical Writing",
      section: "",
      canvasId: 12091,
      students: [
        "Stella Kovacs",
        "Arjun Venkataraghavan-Subramaniam Krishnamurthy",
        "Dana Whitlock",
        "Theo Ramirez",
        "Ingrid Solberg",
        "Malik Greene",
        "Vera Lindholm",
        "Cody Fenwick",
        "Noor Rahimi",
        "Adaeze Nwosu",
      ],
      assignments: [
        {
          id: "e305-memo",
          short: "Memo Revision",
          title: "Memo Revision",
          due: "2026-10-22T23:59",
          pts: 50,
          canvasId: 88240,
          statuses: "GRGGGGGRGG",
          prior: {
            "1": {
              grade: 36,
              comment:
                "Your recommendation is buried on page two. Move it to the first paragraph and resubmit.",
            },
            "7": {
              grade: 33,
              comment:
                "Good data, but the tone is too casual for the audience. Revise for the VP of Operations as reader.",
            },
          },
          pieces: [
            {
              title: "Memo: Reducing Warehouse Returns (v2)",
              words: 540,
              doc: [
                "TO: VP of Operations. RE: Reducing warehouse returns by 12%. Recommendation: Add a photo check at the packing station by January. Returns from mislabeled orders cost $41,000 last quarter, and the pilot cut those errors by more than half at a cost of $6,200. The rest of this memo covers the pilot data and rollout schedule.",
              ],
            },
          ],
        },
        {
          id: "e305-proposal",
          short: "Proposal Draft",
          title: "Proposal Draft",
          due: "2026-10-28T23:59",
          pts: 100,
          lateRate: 2,
          canvasId: 88251,
          statuses: "NGGNGGLGGG",
          lateDays: { "6": 1 },
          rubric: [
            { id: "problem", name: "Problem definition", max: 25 },
            { id: "plan", name: "Plan and feasibility", max: 35 },
            { id: "audience", name: "Audience fit", max: 20 },
            { id: "design", name: "Document design", max: 20 },
          ],
          pieces: [
            {
              title: "Proposal: Shared Lab Equipment Check-Out System",
              words: 2140,
              doc: [
                "Problem. The biology department lost an estimated 310 instructional hours last year because shared equipment was missing or double-booked. Faculty currently reserve equipment through a paper sign-up sheet kept in Room 118.",
                "Proposed solution. We propose a two-phase rollout of a free, open-source check-out tool with barcode labels. Phase one covers twelve high-demand items over the spring term. Phase two extends to all shared equipment if double-bookings fall by at least half.",
                "Budget. Barcode labels and two scanners total $480. Student worker time for set-up is estimated at 40 hours. No ongoing license cost applies.",
              ],
            },
            {
              title: "Proposal: New Campus Food Truck Schedule",
              words: 1680,
              doc: [
                "Introduction. Food trucks are a popular option on campus, but students say that the schedule is confusing. This proposal will explain why the schedule should change.",
                "Plan. The new schedule would have trucks at the north lot on Mondays, Wednesdays, and Fridays. A website could be created to show the schedule.",
                "Conclusion. This plan would make students happier and also help the trucks. I recommend that it be adopted.",
              ],
            },
          ],
        },
        {
          id: "e305-instr",
          short: "Instruction Set",
          title: "Instruction Set",
          due: "2026-11-06T23:59",
          pts: 75,
          statuses: "----------",
        },
      ],
      threads: [
        {
          id: "t-e305-proposal",
          kind: "grading",
          assignmentId: "e305-proposal",
          title: "Grade Proposal Draft",
          time: "55m",
        },
        { id: "t-e305-mail", kind: "messages", title: "Reply to extension requests", time: "4h" },
        { id: "t-e305-ann", kind: "announcement", title: "Week 10: Usability testing", time: "8h" },
        {
          id: "t-e305-memo",
          kind: "grading",
          assignmentId: "e305-memo",
          title: "Grade Memo Revision",
          time: "2d",
        },
      ],
      messages: [
        {
          id: "m-e305-1",
          from: "Malik Greene",
          subject: "Extension on the instruction set?",
          canvasId: 55110,
          body: "My usability testers can't meet until the weekend of Nov 7. Could I have until Nov 9 for the instruction set? The test results are a required part of it.",
          at: "2026-10-29T17:56",
          history: [
            {
              at: "2026-10-21T15:10",
              mine: false,
              text: "Are usability tests required for the instruction set?",
            },
            {
              at: "2026-10-21T17:00",
              mine: true,
              text: "Yes, with at least two testers. Put the results in your appendix.",
            },
          ],
        },
        {
          id: "m-e305-2",
          from: "Noor Rahimi",
          subject: "Is a template allowed?",
          canvasId: 55096,
          body: "Can I use a template for the design of the instruction set, or do I need to build the layout on my own?",
          at: "2026-10-28T14:19",
          history: [],
        },
      ],
      announcements: [
        {
          id: "an-e305-p",
          title: "Workshop Tuesday: bring your draft",
          body: "Bring two printed copies of your proposal draft to Tuesday's workshop.",
          at: "2026-10-27T08:15",
        },
      ],
    },
    {
      id: "hum150",
      schoolId: "rsu",
      code: "HUM 150",
      title: "Film & Society",
      section: "hybrid",
      canvasId: 12103,
      students: [
        "Julian Moreau",
        "Tessa Grayson",
        "Kenji Arai",
        "Lucia Ferrante",
        "Oscar Bell",
        "Ruth Abara",
        "Silas Wray",
        "Mei-Lin Zhou",
        "Dominic Hale",
        "Yara Nasser",
        "Peter Vogel",
        "Amara Diallo",
        "Ezra Stein",
        "Fiona Kerr",
        "Hector Salas",
      ],
      assignments: [
        {
          id: "h150-seq",
          short: "Sequence Analysis",
          title: "Sequence Analysis",
          due: "2026-10-26T23:59",
          pts: 50,
          lateRate: 2,
          canvasId: 88302,
          statuses: "GGNGGGLGGGNGGMG",
          lateDays: { "6": 3 },
          rubric: [
            { id: "shots", name: "Shot-level description", max: 20 },
            { id: "meaning", name: "Interpretation", max: 20 },
            { id: "terms", name: "Film terminology", max: 10 },
          ],
          pieces: [
            {
              title: 'The Dinner Scene in "North Platform"',
              words: 980,
              doc: [
                "The dinner scene runs four minutes and uses only three shots. The first is a wide static frame that keeps the whole family at the table, and each person is cut off from the others by the furniture. There's no score. We hear only the forks.",
                "When the father finally speaks, the film doesn't cut to him. The camera holds on the daughter as she decides not to react. By withholding the expected close-up, the sequence makes her silence the main event.",
              ],
            },
            {
              title: 'Chase Scene in "Blue Ferry"',
              words: 790,
              doc: [
                'The chase in "Blue Ferry" is very exciting and has a lot of fast cuts. The music gets louder as the characters run, and this makes the audience feel nervous.',
                "The director uses many angles of the boat, which shows how dangerous the situation is. This scene relates to society because it shows that people will do anything to escape.",
              ],
            },
          ],
        },
        {
          id: "h150-resp3",
          short: "Film Response 3",
          title: "Film Response 3",
          due: "2026-10-30T23:59",
          pts: 25,
          canvasId: 88311,
          statuses: "N-N--N-N-------",
          pieces: [
            {
              title: 'Response: "Paper Harvest"',
              words: 450,
              doc: [
                '"Paper Harvest" treats the factory closing less as a tragedy than as a slow change in how the town tells time. The whistle stops in the first act, and after that the editing loses its rhythm. I think the film wants us to feel the absence of a schedule we would have complained about, which is an uncomfortable idea.',
              ],
            },
            {
              title: 'Response: "Paper Harvest"',
              words: 380,
              doc: [
                'I liked "Paper Harvest" because it showed how hard life was for the workers after the factory closed. It reminded me of my hometown. The ending was sad but realistic. I think more people should see movies like this.',
              ],
            },
          ],
        },
        {
          id: "h150-notes",
          short: "Screening Notes",
          title: "Screening Notes",
          due: "2026-11-04T23:59",
          pts: 10,
          statuses: "---------------",
        },
      ],
      threads: [
        {
          id: "t-h150-seq",
          kind: "grading",
          assignmentId: "h150-seq",
          title: "Grade Sequence Analysis",
          time: "1h",
        },
        { id: "t-h150-mail", kind: "messages", title: "Reply to screening questions", time: "6h" },
        {
          id: "t-h150-ann",
          kind: "announcement",
          title: "Monday screening moves to Hale Auditorium",
          time: "9h",
        },
        {
          id: "t-h150-resp3",
          kind: "grading",
          assignmentId: "h150-resp3",
          title: "Grade Film Response 3",
          time: "2h",
        },
      ],
      messages: [
        {
          id: "m-h150-1",
          from: "Ezra Stein",
          subject: "Can't make the Monday screening",
          canvasId: 55116,
          body: "I work Monday evenings this month. Is there another way to see the film for the screening notes?",
          at: "2026-10-29T15:30",
          history: [],
        },
        {
          id: "m-h150-2",
          from: "Amara Diallo",
          subject: "Is the sequence analysis graded yet?",
          canvasId: 55094,
          body: "Just checking when grades for the sequence analysis will post. I'd like the feedback before writing Response 3.",
          at: "2026-10-29T09:02",
          history: [
            {
              at: "2026-10-20T09:00",
              mine: false,
              text: "Is the rubric for the sequence analysis posted?",
            },
            { at: "2026-10-20T10:15", mine: true, text: "It's on the assignment page now." },
          ],
        },
        {
          id: "m-h150-3",
          from: "Facilities",
          subject: "Room for your Nov 2 screening",
          canvasId: 55091,
          body: "The projector in your usual room is out for repair, so your HUM 150 screening on Nov 2 moves to Hale Auditorium at 6 PM. Please let your students know.",
          at: "2026-10-29T08:20",
          history: [],
          answer: { at: "2026-10-29T08:45", text: "Thanks, I'll tell the class." },
        },
      ],
      announcements: [
        {
          id: "an-h150-p",
          title: "Online week: discussion replaces lecture",
          body: "Because of the hybrid schedule, this week's meeting is online. Post to the discussion by Thursday.",
          at: "2026-10-19T10:00",
        },
        {
          id: "an-h150-miss",
          title: "If you miss a screening",
          body: "Screenings are Mondays at 6 PM. If you can't make one, each film goes up on the library's streaming page the next morning. Log in with your student account.",
          at: "2026-09-14T09:00",
        },
      ],
    },
  ],
};

/** Not every seeded assignment has a Canvas id, and a path needs one. */
export const assignmentCanvasId = (
  assignment: { canvasId?: number },
  courseIndex: number,
  assignmentIndex: number,
): number => assignment.canvasId ?? 900000 + courseIndex * 100 + assignmentIndex;
