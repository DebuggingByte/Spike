// Fuzzy text matching for lists. Input arrives by voice, so what the user says rarely
// matches what's stored character for character — "the grocery list" has to find
// "Groceries", and "check off the eggs" has to find "Eggs". Shared by db.js (list-name
// lookup) and server.js (item lookup) so both behave the same way.

// Words that carry no meaning when matching a list name or an item.
const STOPWORDS = new Set(['the', 'a', 'an', 'my', 'our', 'some', 'list', 'lists']);

// Crude singularizer — enough for household nouns ("groceries" → "grocery",
// "boxes" → "box", "eggs" → "egg"). Not a real stemmer, and doesn't need to be.
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// "The Grocery List!" → ['grocery']
function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w))
    .map(stem);
}

function normalize(text = '') {
  return tokenize(text).join(' ');
}

// How well `query` matches `candidate`, as a rank where lower is better and
// null means no match at all.
//   0 = identical once normalized      1 = one contains the other
//   2 = every query word appears in the candidate (or vice versa)
//   3 = they share at least one meaningful word
function matchRank(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return null;
  if (q === c) return 0;
  if (c.includes(q) || q.includes(c)) return 1;

  const qWords = new Set(tokenize(query));
  const cWords = new Set(tokenize(candidate));
  const shared = [...qWords].filter(w => cWords.has(w));
  if (!shared.length) return null;
  if (shared.length === qWords.size || shared.length === cWords.size) return 2;
  return 3;
}

// Best matches from `candidates` for `query`, sorted by rank. Everything sharing the
// best rank is returned, so callers can spot a genuine tie and ask which one was meant
// instead of guessing.
function bestMatches(query, candidates, getText = (x) => x) {
  const scored = [];
  for (const candidate of candidates) {
    const rank = matchRank(query, getText(candidate));
    if (rank !== null) scored.push({ candidate, rank });
  }
  if (!scored.length) return [];
  const best = Math.min(...scored.map(s => s.rank));
  return scored.filter(s => s.rank === best).map(s => s.candidate);
}

module.exports = { stem, tokenize, normalize, matchRank, bestMatches };
