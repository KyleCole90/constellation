// What the rule agent would write about the seeded work. The provider never sees this file.
// Rubric keys are criterion names, because a ref belongs to the provider that minted it.

export interface GradeDraft {
  /** Start of the first paragraph. Two assignments have two different submissions under one title. */
  opens: string;
  scores: Readonly<Record<string, number>> | null;
  score: number | null;
  why: Readonly<Record<string, string>>;
  anchors: Readonly<Record<string, readonly { paragraph: number; quote: string }[]>>;
  /** {first} becomes the student's first name. */
  comment: string;
  attach: boolean;
}

export const GRADE_DRAFTS: Readonly<Record<string, readonly GradeDraft[]>> = {
  "The Quiet Sell: How a Bank Ad Borrows Your Grandmother": [
    {
      opens: "Community Trust Bank's thirty-second spo",
      scores: {
        "Thesis and claim": 22,
        "Evidence from the text": 20,
        "Rhetorical analysis": 26,
        "Organization and mechanics": 16,
      },
      score: null,
      why: {
        "Thesis and claim": "Clear, arguable claim in paragraph one. It names the strategy.",
        "Evidence from the text":
          "Two strong moments from the ad, but no second source for the bank's positioning.",
        "Rhetorical analysis":
          "Connects camera height and logo timing to ethos. This is the essay's strength.",
        "Organization and mechanics":
          "Comma splices in paragraph three, and the conclusion restates the thesis.",
      },
      anchors: {
        "Thesis and claim": [
          {
            paragraph: 0,
            quote:
              "I argue that the ad earns trust by delaying its own purpose, using nostalgia as ethos",
          },
        ],
        "Evidence from the text": [
          {
            paragraph: 1,
            quote:
              "The camera stays at table height, which places the viewer in the seat of a child watching someone cook.",
          },
        ],
        "Rhetorical analysis": [
          {
            paragraph: 2,
            quote: "The logo appears only after the hands fold the card and put it in a tin",
          },
        ],
        "Organization and mechanics": [
          {
            paragraph: 2,
            quote:
              "In conclusion the ad works because it sells memory and lets the bank take the credit for it.",
          },
        ],
      },
      comment:
        "{first}, your thesis does real work here. Naming nostalgia as a form of ethos gives the whole essay a direction, and the camera-height observation is the best moment in the paper. To move up a level, bring in one outside source on how banks position themselves, and let the conclusion say why this matters instead of restating the claim. Watch the comma splices in paragraph three.",
      attach: true,
    },
  ],
  "Why the Gym Commercial Yells at You": [
    {
      opens: "The Ironclad Fitness commercial is loud,",
      scores: {
        "Thesis and claim": 15,
        "Evidence from the text": 19,
        "Rhetorical analysis": 18,
        "Organization and mechanics": 15,
      },
      score: null,
      why: {
        "Thesis and claim": "Announces a topic and a list of appeals. No arguable claim yet.",
        "Evidence from the text": "Accurate moments from the ad, each quoted or described.",
        "Rhetorical analysis":
          "Labels the appeals more than it explains them. The footnote point is a promising start.",
        "Organization and mechanics":
          "Clean sentences, but the structure follows the three appeals instead of an argument.",
      },
      anchors: {
        "Thesis and claim": [
          {
            paragraph: 0,
            quote: "In this essay I will talk about pathos, ethos, and logos in the commercial",
          },
        ],
        "Evidence from the text": [
          {
            paragraph: 1,
            quote: "Logos is used when the ad says members lose an average of twelve pounds.",
          },
        ],
        "Rhetorical analysis": [
          {
            paragraph: 2,
            quote:
              "The twelve pounds statistic has a small footnote at the bottom that you can barely read",
          },
        ],
        "Organization and mechanics": [
          { paragraph: 2, quote: "Overall the ad is effective because it uses all three appeals." },
        ],
      },
      comment:
        '{first}, you found the right moments in this ad, and your point about the unreadable footnote is the most interesting sentence in the essay. Try making that your thesis. Something like "the ad depends on viewers not checking" gives you a claim to prove, and the three appeals become evidence rather than the outline. Come see me if you want to talk through a revision plan.',
      attach: true,
    },
  ],
  'Response to "The Case for Slow Reading"': [
    {
      opens: "The author's claim that skimming changes",
      scores: null,
      score: 18,
      why: {},
      anchors: {},
      comment:
        "{first}, rereading and then questioning the study is the habit this assignment is after. Good response. Next time quote the sentence you are pushing back on.",
      attach: false,
    },
    {
      opens: "I agree with the author that people do n",
      scores: null,
      score: 14,
      why: {},
      anchors: {},
      comment:
        "{first}, the job example is a good connection. Push further by naming one specific claim from the article and saying where it holds up and where it does not. Agreement alone earns partial credit here.",
      attach: false,
    },
  ],
  "Annotated Bibliography: Four-Day School Weeks": [
    {
      opens: 'Anderson, Tess. "Attendance and Achievem',
      scores: { "Source quality": 18, "Annotation depth": 17, "MLA format": 9 },
      score: null,
      why: {
        "Source quality":
          "Mix of peer-reviewed and policy work, with a real counterargument source.",
        "Annotation depth": "Says how each source fits the paper, not only what it says.",
        "MLA format": "One hanging indent issue. Otherwise correct.",
      },
      anchors: {
        "Source quality": [
          {
            paragraph: 1,
            quote:
              'Morales, Ivan. "Who Watches the Kids on Friday?" Policy Brief, Center for Family Economics, 2023.',
          },
        ],
        "Annotation depth": [
          {
            paragraph: 0,
            quote:
              "I will use this as my main counter to the claim that shorter weeks hurt learning",
          },
        ],
        "MLA format": [{ paragraph: 1, quote: "Morales, Ivan." }],
      },
      comment:
        "{first}, this is what an annotated bibliography should do. You explain how each source functions in your argument, and you went looking for one that complicates your thesis. Fix the hanging indent on your second entry, then you are ready to draft.",
      attach: false,
    },
  ],
  "Annotated Bibliography: Social Media and Teen Sleep": [
    {
      opens: 'Clarke, Jo. "Screens After Dark." Health',
      scores: { "Source quality": 14, "Annotation depth": 11, "MLA format": 8 },
      score: null,
      why: {
        "Source quality": "One strong study, one consumer health article.",
        "Annotation depth":
          'Summaries are accurate but stop at "helpful." Needs how each source will be used.',
        "MLA format": "Citation order and italics are mostly right.",
      },
      anchors: {
        "Source quality": [
          { paragraph: 0, quote: 'Clarke, Jo. "Screens After Dark." Health Today Online, 2024.' },
        ],
        "Annotation depth": [{ paragraph: 0, quote: "It is helpful for my paper." }],
        "MLA format": [{ paragraph: 1, quote: "Patel, Reena, et al." }],
      },
      comment: `{first}, the Patel study is a strong find. Your annotations summarize well, but "helpful for my paper" doesn't tell me how. For each source, add a sentence on what part of your argument it supports or challenges. Consider replacing the Health Today piece with something closer to Patel's level.`,
      attach: false,
    },
  ],
  "How Tap Water Gets to Your Kitchen": [
    {
      opens: "[0:00] Turn on your faucet. In about thr",
      scores: {
        "Content and organization": 36,
        "Vocal and physical delivery": 31,
        "Visual aid": 17,
      },
      score: null,
      why: {
        "Content and organization":
          "Clean three-part structure, signposted, with a callback in the close.",
        "Vocal and physical delivery":
          "Good pacing. Eyes drop to notes through most of the middle section.",
        "Visual aid": "Simple, readable slides. The settling basin photo earns its laugh.",
      },
      anchors: {
        "Content and organization": [
          {
            paragraph: 2,
            quote: "So, reservoir, treatment, and the pressure system under your street.",
          },
        ],
        "Vocal and physical delivery": [
          { paragraph: 1, quote: "The second stop is the treatment plant" },
        ],
        "Visual aid": [{ paragraph: 1, quote: "It looks like a very boring swimming pool." }],
      },
      comment:
        "{first}, your structure is the best thing here. A listener can't get lost with those three stops, and the opening statistic pulled me in right away. For your next speech, practice the middle section until you can look up from your notes. Your delivery in the first minute shows what it looks like when you do.",
      attach: false,
    },
  ],
  "What Happens to Your Recycling": [
    {
      opens: "[0:00] Hi everyone, today I'm going to i",
      scores: {
        "Content and organization": 28,
        "Vocal and physical delivery": 26,
        "Visual aid": 10,
      },
      score: null,
      why: {
        "Content and organization":
          "Accurate information, but the opening doesn't give a reason to listen.",
        "Vocal and physical delivery":
          "Filler words in the middle. The self-aware ending is charming.",
        "Visual aid": "The chart isn't legible at recording size, and you say so on camera.",
      },
      anchors: {
        "Content and organization": [
          { paragraph: 0, quote: "today I'm going to inform you about recycling" },
        ],
        "Vocal and physical delivery": [
          {
            paragraph: 1,
            quote: "So, um, the truck takes it to a place called a materials recovery facility",
          },
        ],
        "Visual aid": [
          {
            paragraph: 1,
            quote: "I have a chart here but it's kind of hard to see, sorry about that.",
          },
        ],
      },
      comment:
        '{first}, your facts are solid and the ending made me smile. Two fixes will raise this a lot. Open with something surprising about recycling rather than the topic, and rebuild the chart with fewer labels so that it reads on a small screen. Record one practice run and count your "ums" before the next speech.',
      attach: false,
    },
  ],
  "Discussion 8: Audience Analysis": [
    {
      opens: "My audience for the informative speech ",
      scores: null,
      score: 10,
      why: {},
      anchors: {},
      comment:
        "{first}, you named a real audience and let what they already know shape the speech. Good reply to Emil, too.",
      attach: false,
    },
    {
      opens: "I will speak to first-year students abou",
      scores: null,
      score: 8,
      why: {},
      anchors: {},
      comment:
        "{first}, you know who you're speaking to and what they need first. Reply to a classmate's post for the last two points.",
      attach: false,
    },
  ],
  "Outline: Adopt a Storm Drain": [
    {
      opens: "I. Attention: The drain on your street f",
      scores: null,
      score: 18,
      why: {},
      anchors: {},
      comment:
        "{first}, you turned in a well-built Monroe sequence, and early. Your attention step is specific and local. Add one source for the city's flooding numbers in the Need section.",
      attach: false,
    },
  ],
  "Outline: Why You Should Learn CPR": [
    {
      opens: "I. Intro: CPR is important. II. Facts ab",
      scores: null,
      score: 13,
      why: {},
      anchors: {},
      comment: `{first}, the topic is a good choice for a persuasive speech. Expand each point into full-sentence claims, and open with a story or a number instead of "CPR is important." Use the Monroe headings from this week's module.`,
      attach: false,
    },
  ],
  'The Door That Stays Open: Reading the Last Page of "The Harbor House"': [
    {
      opens: 'The last page of "The Harbor House" repe',
      scores: {
        "Attention to the passage": 32,
        "Language and form": 31,
        "Interpretive argument": 25,
      },
      score: null,
      why: {
        "Attention to the passage": "Works from one word across nine lines. Exact and well chosen.",
        "Language and form": 'Handles grammar as meaning, especially the "still open" sentence.',
        "Interpretive argument":
          "Strong final claim, which arrives late and could organize the opening.",
      },
      anchors: {
        "Attention to the passage": [
          { paragraph: 0, quote: 'repeats the word "still" four times in nine lines' },
        ],
        "Language and form": [
          { paragraph: 1, quote: "the sentence refuses to tell us whether anyone has left" },
        ],
        "Interpretive argument": [
          {
            paragraph: 2,
            quote: "I read the ending as a decision the narrator cannot admit to making.",
          },
        ],
      },
      comment: `{first}, tracking "still" through those nine lines is excellent close reading. You're asking how the grammar produces uncertainty, and that's the level I want from everyone in this course. Your best claim is in the last paragraph. In your next paper, try leading with it and let the close reading prove it.`,
      attach: false,
    },
  ],
  'Family Conflict in "The Harbor House"': [
    {
      opens: '"The Harbor House" is about a family wit',
      scores: {
        "Attention to the passage": 23,
        "Language and form": 20,
        "Interpretive argument": 19,
      },
      score: null,
      why: {
        "Attention to the passage":
          "Picks real moments, but moves through plot rather than one passage.",
        "Language and form": '"Air went thin" is noticed and not unpacked.',
        "Interpretive argument":
          "Theme stated at a general level. Needs a claim someone could dispute.",
      },
      anchors: {
        "Attention to the passage": [
          {
            paragraph: 1,
            quote:
              "In the second section the daughter finds the letter and decides not to tell anyone.",
          },
        ],
        "Language and form": [
          { paragraph: 1, quote: 'the "air went thin," which shows the tension' },
        ],
        "Interpretive argument": [
          {
            paragraph: 2,
            quote: "This shows the theme that communication is important in families.",
          },
        ],
      },
      comment: `{first}, you've understood the story's central tension, and the "air went thin" line is a great catch. This assignment asks you to slow down on one passage rather than cover the plot. Try writing a full page on that one phrase. Why thin, why air? I think you'll find your thesis there.`,
      attach: false,
    },
  ],
  "Memo: Reducing Warehouse Returns (v2)": [
    {
      opens: "TO: VP of Operations. RE: Reducing wareh",
      scores: null,
      score: 46,
      why: {},
      anchors: {},
      comment:
        "{first}, the revision works. Your recommendation is in the first line with its cost and benefit, which is what a VP needs. Nice job cutting the background section. This is ready for the portfolio.",
      attach: false,
    },
  ],
  "Proposal: Shared Lab Equipment Check-Out System": [
    {
      opens: "Problem. The biology department lost an ",
      scores: {
        "Problem definition": 23,
        "Plan and feasibility": 30,
        "Audience fit": 16,
        "Document design": 15,
      },
      score: null,
      why: {
        "Problem definition": "Quantified with a cost in hours. Strong.",
        "Plan and feasibility": "Phased, with a measurable decision point. Missing a risk section.",
        "Audience fit":
          "Written for the department chair, though it assumes some technical knowledge.",
        "Document design": "Headings help. The budget should be a table.",
      },
      anchors: {
        "Problem definition": [
          { paragraph: 0, quote: "lost an estimated 310 instructional hours last year" },
        ],
        "Plan and feasibility": [
          {
            paragraph: 1,
            quote:
              "Phase two extends to all shared equipment if double-bookings fall by at least half.",
          },
        ],
        "Audience fit": [
          { paragraph: 1, quote: "a free, open-source check-out tool with barcode labels" },
        ],
        "Document design": [{ paragraph: 2, quote: "Barcode labels and two scanners total $480." }],
      },
      comment:
        "{first}, the decision point at the end of phase one makes this proposal credible, and the 310-hour figure defines the problem well. For the final version, add a short risks section and put the budget in a table, since your chair will look for it there.",
      attach: true,
    },
  ],
  "Proposal: New Campus Food Truck Schedule": [
    {
      opens: "Introduction. Food trucks are a popular ",
      scores: {
        "Problem definition": 15,
        "Plan and feasibility": 21,
        "Audience fit": 12,
        "Document design": 12,
      },
      score: null,
      why: {
        "Problem definition": 'Relies on "students say." Needs a number or a survey result.',
        "Plan and feasibility": "A real idea, with no owner, cost, or timeline yet.",
        "Audience fit": "Reader isn't named. Who can approve this?",
        "Document design": "Headings are present. Body text is otherwise undifferentiated.",
      },
      anchors: {
        "Problem definition": [
          { paragraph: 0, quote: "students say that the schedule is confusing" },
        ],
        "Plan and feasibility": [
          { paragraph: 1, quote: "A website could be created to show the schedule." },
        ],
        "Audience fit": [{ paragraph: 2, quote: "I recommend that it be adopted." }],
        "Document design": [
          { paragraph: 0, quote: "Introduction. Food trucks are a popular option on campus" },
        ],
      },
      comment:
        "{first}, you have a clear idea here, and this is a draft, so there's time to build it out. Start by naming who can approve this proposal, then give them what they need: a short survey result for the problem, and an owner, cost, and timeline for the plan. Let's talk at Tuesday's workshop.",
      attach: true,
    },
  ],
  'The Dinner Scene in "North Platform"': [
    {
      opens: "The dinner scene runs four minutes and u",
      scores: { "Shot-level description": 18, Interpretation: 17, "Film terminology": 8 },
      score: null,
      why: {
        "Shot-level description": "Accurate shot count, and framing is described with care.",
        Interpretation: "Reads the withheld close-up as a choice with a reason.",
        "Film terminology": 'Uses "static frame" correctly. Could name offscreen sound.',
      },
      anchors: {
        "Shot-level description": [
          { paragraph: 0, quote: "The dinner scene runs four minutes and uses only three shots." },
        ],
        Interpretation: [
          {
            paragraph: 1,
            quote:
              "By withholding the expected close-up, the sequence makes her silence the main event.",
          },
        ],
        "Film terminology": [{ paragraph: 0, quote: "a wide static frame" }],
      },
      comment: `{first}, your attention to what the film withholds makes this analysis work. The point about the father's line playing over the daughter's face is the kind of observation I hope for. Pick up the term "offscreen sound" for next time, because it's exactly what you're describing.`,
      attach: false,
    },
  ],
  'Chase Scene in "Blue Ferry"': [
    {
      opens: 'The chase in "Blue Ferry" is very exciti',
      scores: { "Shot-level description": 11, Interpretation: 12, "Film terminology": 5 },
      score: null,
      why: {
        "Shot-level description": "Describes the effect but not specific shots.",
        Interpretation: "The society link is broad and could apply to many chase scenes.",
        "Film terminology": 'Few film terms beyond "cuts" and "angles."',
      },
      anchors: {
        "Shot-level description": [{ paragraph: 0, quote: "has a lot of fast cuts" }],
        Interpretation: [
          {
            paragraph: 1,
            quote:
              "This scene relates to society because it shows that people will do anything to escape.",
          },
        ],
        "Film terminology": [{ paragraph: 1, quote: "The director uses many angles of the boat" }],
      },
      comment:
        '{first}, you noticed how the music and cutting build tension, which is a good start. Rewatch one 30-second stretch and write down each shot: how long it lasts, how far the camera is, what moves. That detail will give you a sharper claim about what this chase says beyond "escape."',
      attach: false,
    },
  ],
  'Response: "Paper Harvest"': [
    {
      opens: '"Paper Harvest" treats the factory closi',
      scores: null,
      score: 23,
      why: {},
      anchors: {},
      comment:
        "{first}, your reading of the whistle and the editing rhythm is sharp. You've tied a formal choice to the film's social argument, and that's the goal of these responses. Well done.",
      attach: false,
    },
    {
      opens: 'I liked "Paper Harvest" because it showe',
      scores: null,
      score: 18,
      why: {},
      anchors: {},
      comment:
        "{first}, the connection to your hometown is worth exploring. Next time, pick one scene and describe how the film makes you feel that hardship. Then your personal connection will have evidence behind it.",
      attach: false,
    },
  ],
};

export const REPLY_DRAFTS: Readonly<Record<string, string>> = {
  "Essay 2 is going to be late":
    "Hi Imani, I'm sorry to hear about your brother, and I hope he's doing better. Yes, please submit Essay 2 by Sunday, Nov 1 at 11:59 PM. I'll waive the late penalty, and you don't need to send a note. If Sunday becomes a problem, tell me and we'll work out another date.",
  "Late penalty question":
    "Hi Aaliyah, it counts as two days late, because the deadline was Monday at 11:59 PM and the course site recorded your submission Wednesday morning. That makes the penalty 5 points. You'll see it listed separately from your rubric score when your grade posts.",
  "Can I redo Reading Response 5?":
    "Hi Owen, reading responses can't be redone, but your lowest two scores drop at the end of the term, so a 12 won't hurt you much. I'm happy to look at a draft of your next one before you submit it.",
  "Does a podcast count as a source?":
    "Hi Gwen, yes, you can use it. Cite the episode in MLA, and also find the researcher's published study so that you have a source to quote for the data. The podcast is good for framing, and the study is your evidence.",
  "Library login not working":
    "Hi Bo, the library help desk can reset your database access. We also have the library session next Tuesday, and we can check it then if it's still not working.",
  "My video won't upload":
    "Hi Wren, a 2 GB file is likely over the upload limit. Upload it to your school video account, set it to unlisted, and paste the link as a text entry. That counts as on time.",
  "Audience requirement":
    "Hi Paige, you need at least three people in the room for Speech 3, and they should be visible in at least one wide shot. They can be family or roommates. If that's hard to arrange, message me and we'll find an option that works.",
  "Midterm paper topic":
    "Hi Harper, yes, that comparison could work well. Keep it focused on the endings, and make your claim about what the comparison reveals, not only that they're similar. Send me a two-sentence thesis by Monday and I'll give you quick feedback.",
  "Class on Tuesday":
    "Hi Yusuf, thanks for telling me ahead of time. Before you leave, line up a classmate to share notes with you. Your midterm is still due Wednesday, Nov 4 at 5 PM. If the trip runs late, let me know by Monday.",
  "Extension on the instruction set?":
    "Hi Malik, yes, you can have until Monday, Nov 9 at 11:59 PM. Since you gave me a clear reason early, no penalty applies. Send me your testers' task list before the session if you'd like feedback.",
  "Is a template allowed?":
    "Hi Noor, you can use a template. Change whatever doesn't help your reader, so the layout supports the task.",
  "Can't make the Monday screening":
    "Hi Ezra, thanks for telling me. Yes, each film goes up on the library's streaming page the morning after the screening. Log in with your student account. Your screening notes are due Wednesday, Nov 4 at 11:59 PM, so you'll have time to watch it.",
  "Is the sequence analysis graded yet?":
    "Hi Amara, yours is already graded, so you can see your score on the course site now. For Response 3, describe individual shots before you interpret them. That's due tonight at 11:59 PM.",
};

export const REPLY_SOURCES: Readonly<Record<string, string>> = {
  "Can't make the Monday screening": "Read your post on missed screenings and the notes due date",
  "Is the sequence analysis graded yet?": "Checked Amara's grade and the Film Response 3 due date",
  "Late penalty question": "Checked the late policy and the Essay 2 due date",
  "Can I redo Reading Response 5?": "Read your post on how reading responses count",
  "My video won't upload": "Read your post on Speech 3 audiences and uploads",
  "Audience requirement": "Read your post on Speech 3 audiences and uploads",
};

export const ANNOUNCEMENT_DRAFTS: Readonly<
  Record<string, { title: string; body: string; from?: string; say?: string }>
> = {
  "ENG 101": {
    title: "Week 10: Essay 3 starts Monday",
    body: "Good morning, ENG 101. Essay 3 starts Monday. Bring two possible topics to class. Your outline is due Friday, Nov 6 at 11:59 PM.",
  },
  "ENG 102": {
    title: "Library session next Tuesday",
    body: "ENG 102 meets in the library next Tuesday, Nov 3 instead of our usual room. Bring a laptop and your research question. We'll practice finding primary sources for your research paper draft, which is due Thursday, Nov 5.",
  },
  "COMM 110": {
    title: "Week 10: Persuasive speaking",
    body: "Hello, COMM 110. This week's module covers Monroe's motivated sequence. Your Speech 3 outline is due Tuesday, Nov 3 at 11:59 PM.",
  },
  "ENG 210": {
    title: "Midterm paper guidelines",
    body: "Hello, ENG 210. The midterm paper is due Wednesday, Nov 4 at 5 PM. It should be 5 to 6 pages on one or two works from the syllabus. Use one passage as your anchor.",
  },
  "ENG 305": {
    title: "Week 10: Usability testing",
    body: "Hello, ENG 305. Your instruction set is due Friday, Nov 6 at 11:59 PM. Usability tests are required, with at least two testers. Put the results in your appendix.",
    from: "due dates and your earlier answer on usability tests",
  },
  "HUM 150": {
    title: "Monday screening moves to Hale Auditorium",
    body: "Hello, HUM 150. Monday's screening on Nov 2 moves to Hale Auditorium at 6 PM. Screening notes are due Wednesday, Nov 4 at 11:59 PM.",
    from: "the note from Facilities about Hale Auditorium",
    say: "Here's the post you told Facilities you'd send, with the notes due date added. Review it before sending.",
  },
};
