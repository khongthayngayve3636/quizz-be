export type McqQuestion = {
  type: "mcq";
  question: string;
  options: string[];
  answer: string;
};

export type UnscrambleQuestion = {
  type: "unscramble";
  question: string;
  answer: string;
};

export type QuizQuestion = McqQuestion | UnscrambleQuestion;

export const sampleQuiz: QuizQuestion[] = [
  {
    type: "mcq",
    question: "What does reservation mean?",
    options: ["Airport", "Booking", "Train", "Hotel"],
    answer: "Booking"
  },
  {
    type: "unscramble",
    question: "gnir",
    answer: "ring"
  },
  {
    type: "mcq",
    question: "Which phrase is best for starting an OPIC travel answer?",
    options: [
      "I would like to talk about a trip I took.",
      "No, because maybe yes.",
      "The answer is grammar.",
      "Travel is a vocabulary."
    ],
    answer: "I would like to talk about a trip I took."
  },
  {
    type: "unscramble",
    question: "letvo",
    answer: "hotel"
  },
  {
    type: "mcq",
    question: "What is a tourist attraction?",
    options: ["A place visitors like to see", "A train ticket", "A weather report", "A small suitcase"],
    answer: "A place visitors like to see"
  }
];

