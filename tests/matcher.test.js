const assert = require("assert");

process.env.NODE_ENV = "test";

const { findCurseHits } = require("../backend/server");

const words = [
  { word: "Okay", start: 0, end: 0.3 },
  { word: "bullshit", start: 0.4, end: 0.9 },
  { word: "Game", start: 1, end: 1.2 },
  { word: "over", start: 1.2, end: 1.5 },
  { word: "Shit", start: 1.6, end: 1.9 },
  { word: "Can", start: 2, end: 2.1 },
  { word: "I", start: 2.1, end: 2.15 },
  { word: "fuck", start: 2.2, end: 2.45 },
  { word: "off", start: 2.45, end: 2.7 },
  { word: "Fuck", start: 3, end: 3.2 },
  { word: "it", start: 3.2, end: 3.35 },
  { word: "cold", start: 3.4, end: 3.7 },
  { word: "Goddamn", start: 4, end: 4.5 },
  { word: "god", start: 5, end: 5.2 },
  { word: "damn", start: 5.2, end: 5.45 },
  { word: "f*ck", start: 6, end: 6.25 },
  { word: "sh!t", start: 7, end: 7.25 },
  { word: "a$$hole", start: 8, end: 8.5 },
];

const hits = findCurseHits(words, [
  "fuck",
  "fuck off",
  "fuck it",
  "shit",
  "bullshit",
  "bull shit",
  "god damn",
  "f*ck",
  "sh*t",
  "asshole",
]);

assert.deepStrictEqual(
  hits.map((hit) => hit.word),
  ["bullshit", "Shit", "fuck off", "Fuck it", "Goddamn", "god damn", "f*ck", "sh!t", "a$$hole"],
);
assert.strictEqual(hits[0].start, 0.4);
assert.strictEqual(hits[2].end, 2.7);
assert.strictEqual(hits[4].start, 4);
assert.strictEqual(hits[5].end, 5.45);

console.log("matcher ok");
