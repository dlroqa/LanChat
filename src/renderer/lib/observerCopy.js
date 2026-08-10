// What the observers' surfaces say.
//
// Here rather than inside the component, for the reason counsel.js gives about
// its own sentences: the request is described twice — as what is drawn, and as
// the one line a screen reader is given — and two places each writing their own
// version is how they start disagreeing about what was asked.
//
// Pure and DOM-free, so every sentence the feature produces can be asserted in a
// test rather than read off a screenshot.

// The whole request in one sentence, for somebody hearing it rather than seeing
// it. Who is asking, and what they would say — in that order, because the name
// is what makes it a request from somebody rather than a system message.
export function floorAsk(floor) {
  if (!floor) return '';
  const who = floor.who || 'An observer';
  return `${who} would like to say something: ${floor.claim}`;
}
