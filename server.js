const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'books.json');
const DEFAULT_CLIENT_ID = 'legacy';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, '[]\n', 'utf8');
  }
}

async function readBooks() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeBooks(books) {
  await fs.writeFile(DATA_FILE, `${JSON.stringify(books, null, 2)}\n`, 'utf8');
}

async function readStore() {
  const parsed = await readBooks();

  if (Array.isArray(parsed)) {
    return {
      byClient: {
        [DEFAULT_CLIENT_ID]: parsed,
      },
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { byClient: {} };
  }

  if (!parsed.byClient || typeof parsed.byClient !== 'object') {
    return { byClient: {} };
  }

  return parsed;
}

async function writeStore(store) {
  await writeBooks(store);
}

function getClientId(req) {
  const incoming = normalizeText(req.get('x-client-id') || req.query.clientId || '');
  return incoming || DEFAULT_CLIENT_ID;
}

function getClientBooks(store, clientId) {
  const books = store.byClient?.[clientId];
  return Array.isArray(books) ? books : [];
}

function normalizeText(value) {
  return (value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function getMeaningfulTokens(value) {
  return normalizeKey(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

const IGNORED_WORDS = new Set([
  'el',
  'la',
  'los',
  'las',
  'lo',
  'de',
  'del',
  'y',
  'en',
  'un',
  'una',
  'con',
  'para',
  'por',
  'sobre',
  'desde',
  'best',
  'world',
  'book',
  'the',
  'of',
  'and',
  'a',
]);

const LOW_QUALITY_TITLE_MARKERS = [
  'summary',
  'resumen',
  'avance',
  'preview',
  'signed',
  'autographed',
  'special edition',
  'illustrated edition',
  'edicion aniversario',
  'edicion coleccionista',
  'coleccion completa',
  'complete collection',
  'collector',
  'collectors',
  'speciale editie',
  'study guide',
  'guide',
  'guia',
  'critical',
  'critica',
  'inside the world',
  'foundations',
  'challenging genres',
  'workbook',
  'companion',
  'annotated',
  'adapted by',
];

const LOW_QUALITY_CATEGORY_MARKERS = [
  'literary criticism',
  'literary collections',
  'social science',
  'language arts',
  'study aids',
  'performing arts',
  'reference',
  'education',
];

function isLowQualityCandidate(title) {
  const normalized = normalizeKey(title);
  return LOW_QUALITY_TITLE_MARKERS.some((marker) => normalized.includes(marker));
}

function hasLowQualityCategories(categories = []) {
  return categories.some((category) => {
    const normalized = normalizeKey(category);
    return LOW_QUALITY_CATEGORY_MARKERS.some((marker) => normalized.includes(marker));
  });
}

function isNoisyCandidate(candidate, { strict = false } = {}) {
  if (!candidate || !candidate.title) {
    return true;
  }

  if (isLowQualityCandidate(candidate.title)) {
    return true;
  }

  if (hasLowQualityCategories([...(candidate.categories || []), ...(candidate.subjects || [])])) {
    return true;
  }

  if (strict && !candidate.author && !candidate.pages) {
    return true;
  }

  return false;
}

function countTokenMatches(text, tokens) {
  const haystack = normalizeKey(text);
  return tokens.filter((token) => haystack.includes(token)).length;
}

function trimAndRankEntries(counter, limit) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function toOpenLibraryCandidate(doc, fallbackAuthor = '') {
  return {
    title: normalizeText(doc.title),
    author: Array.isArray(doc.author_name) ? normalizeText(doc.author_name[0]) : fallbackAuthor,
    pages: Number.isFinite(doc.number_of_pages_median) ? doc.number_of_pages_median : null,
    firstPublishYear: Number.isInteger(doc.first_publish_year) ? doc.first_publish_year : null,
    subjects: Array.isArray(doc.subject)
      ? doc.subject.filter(Boolean).map((subject) => normalizeText(subject)).slice(0, 6)
      : [],
    categories: [],
    description: '',
    source: 'Open Library',
  };
}

function toGoogleCandidate(item) {
  const info = item.volumeInfo || {};
  const categories = Array.isArray(info.categories)
    ? info.categories.filter(Boolean).map((category) => normalizeText(category)).slice(0, 6)
    : [];

  return {
    title: normalizeText(info.title),
    author: Array.isArray(info.authors) ? normalizeText(info.authors[0]) : '',
    pages: Number.isFinite(info.pageCount) ? info.pageCount : null,
    firstPublishYear: info.publishedDate ? Number.parseInt(info.publishedDate, 10) || null : null,
    subjects: categories,
    categories,
    description: typeof info.description === 'string' ? info.description : '',
    source: 'Google Books',
  };
}

function scoreMatch(candidate, { title, author }) {
  const exactTitle = normalizeKey(title);
  const exactAuthor = normalizeKey(author);
  const candidateTitle = normalizeKey(candidate.title || '');
  const candidateAuthor = normalizeKey(candidate.author || '');

  const titleScore = candidateTitle === exactTitle ? 2 : candidateTitle.includes(exactTitle) ? 1 : 0;
  const authorScore = exactAuthor && candidateAuthor ? (candidateAuthor.includes(exactAuthor) ? 1 : 0) : 0;
  return titleScore + authorScore;
}

async function fetchFromOpenLibrary({ title, author }) {
  const params = new URLSearchParams({
    title,
    limit: '10',
  });

  if (author) {
    params.set('author', author);
  }

  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Bookyy/1.0 (reading tracker app)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Open Library respondio ${response.status}.`);
  }

  const payload = await response.json();
  const docs = Array.isArray(payload.docs) ? payload.docs : [];

  const withPages = docs.filter((doc) => Number.isFinite(doc.number_of_pages_median));

  if (withPages.length === 0) {
    throw new Error('Open Library no devolvio paginas.');
  }

  const sorted = withPages.sort((a, b) => {
    const first = {
      title: a.title,
      author: Array.isArray(a.author_name) ? a.author_name[0] : '',
    };
    const second = {
      title: b.title,
      author: Array.isArray(b.author_name) ? b.author_name[0] : '',
    };
    return scoreMatch(second, { title, author }) - scoreMatch(first, { title, author });
  });

  const best = sorted[0];

  return {
    pages: best.number_of_pages_median,
    sourceTitle: best.title,
    sourceAuthor: Array.isArray(best.author_name) ? best.author_name[0] : null,
    provider: 'Open Library',
  };
}

async function fetchFromGoogleBooks({ title, author }) {
  const query = author ? `intitle:${title}+inauthor:${author}` : `intitle:${title}`;
  const params = new URLSearchParams({
    q: query,
    maxResults: '8',
    printType: 'books',
    langRestrict: 'es',
  });

  const response = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Books respondio ${response.status}.`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const withPages = items.filter((item) => Number.isFinite(item.volumeInfo?.pageCount));

  if (withPages.length === 0) {
    throw new Error('Google Books no devolvio paginas.');
  }

  const sorted = withPages.sort((a, b) => {
    const first = {
      title: a.volumeInfo?.title || '',
      author: Array.isArray(a.volumeInfo?.authors) ? a.volumeInfo.authors[0] : '',
    };
    const second = {
      title: b.volumeInfo?.title || '',
      author: Array.isArray(b.volumeInfo?.authors) ? b.volumeInfo.authors[0] : '',
    };
    return scoreMatch(second, { title, author }) - scoreMatch(first, { title, author });
  });

  const best = sorted[0].volumeInfo;

  return {
    pages: best.pageCount,
    sourceTitle: best.title,
    sourceAuthor: Array.isArray(best.authors) ? best.authors[0] : null,
    provider: 'Google Books',
  };
}

async function fetchBookPages({ title, author }) {
  const errors = [];

  for (const provider of [fetchFromOpenLibrary, fetchFromGoogleBooks]) {
    try {
      return await provider({ title, author });
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`No se encontraron paginas automaticamente. ${errors.join(' ')}`);
}

async function fetchOpenLibrarySuggestions(query, mode = 'title') {
  const params = new URLSearchParams({
    limit: '8',
  });

  params.set(mode, query);

  const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, {
    headers: {
      'User-Agent': 'Bookyy/1.0 (reading tracker app)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Open Library respondio ${response.status}.`);
  }

  const payload = await response.json();
  const docs = Array.isArray(payload.docs) ? payload.docs : [];

  return docs.slice(0, 8).map((doc) => ({
    title: doc.title || '',
    author: Array.isArray(doc.author_name) ? doc.author_name[0] : '',
    pages: Number.isFinite(doc.number_of_pages_median) ? doc.number_of_pages_median : null,
    editionCount: Number.isInteger(doc.edition_count) ? doc.edition_count : 0,
    firstPublishYear: Number.isInteger(doc.first_publish_year) ? doc.first_publish_year : null,
    source: 'Open Library',
  }));
}

async function fetchGoogleSuggestions(query) {
  const params = new URLSearchParams({
    q: query,
    maxResults: '8',
    printType: 'books',
  });

  const response = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Google Books respondio ${response.status}.`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];

  return items.map((item) => ({
    title: item.volumeInfo?.title || '',
    author: Array.isArray(item.volumeInfo?.authors) ? item.volumeInfo.authors[0] : '',
    pages: Number.isFinite(item.volumeInfo?.pageCount) ? item.volumeInfo.pageCount : null,
    editionCount: 0,
    firstPublishYear: item.volumeInfo?.publishedDate
      ? Number.parseInt(item.volumeInfo.publishedDate, 10) || null
      : null,
    source: 'Google Books',
  }));
}

async function fetchSuggestions(query) {
  const queryTokens = getMeaningfulTokens(query);
  const normalizedQuery = normalizeKey(query);
  const batches = [];

  try {
    batches.push(await fetchOpenLibrarySuggestions(query, 'title'));
  } catch {
    batches.push([]);
  }

  try {
    batches.push(await fetchOpenLibrarySuggestions(query, 'q'));
  } catch {
    batches.push([]);
  }

  try {
    batches.push(await fetchGoogleSuggestions(query));
  } catch {
    batches.push([]);
  }

  const ranked = uniqueBy(
    batches
      .flat()
      .filter((item) => item.title)
      .filter((item) => !isNoisyCandidate(item, { strict: true }))
      .map((item) => ({
        ...item,
        tokenMatches: queryTokens.filter((token) => normalizeKey(item.title).includes(token)).length,
        exactTitle: normalizeKey(item.title) === normalizedQuery,
        sourceWeight: item.source === 'Google Books' ? 3 : 1,
        authorWeight: item.author ? 2 : 0,
        pagesWeight: item.pages && item.pages > 0 ? 2 : 0,
        editionWeight: item.editionCount ? Math.min(2, item.editionCount / 10) : 0,
        recencyWeight: item.firstPublishYear ? 1 : 0,
        relevance:
          scoreMatch(item, { title: query, author: '' }) +
          (normalizeKey(item.title).includes(normalizeKey(query)) ? 2 : 0),
      }))
      .filter((item) => item.relevance > 0 || item.tokenMatches >= 2)
      .map((item) => ({
        ...item,
        relevance:
          item.relevance +
          item.tokenMatches +
          (item.exactTitle ? 5 : 0) +
          item.sourceWeight +
          item.authorWeight +
          item.pagesWeight +
          item.editionWeight +
          item.recencyWeight,
      }))
      .sort((a, b) => b.relevance - a.relevance),
    (item) => `${normalizeKey(item.title)}::${normalizeKey(item.author)}`
  );

  return ranked
    .slice(0, 6)
    .map((item) => ({
      title: item.title,
      author: item.author,
      pages: item.pages,
      source: item.source,
    }));
}

async function searchOpenLibrary(params) {
  const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, {
    headers: {
      'User-Agent': 'Bookyy/1.0 (reading tracker app)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Open Library respondio ${response.status}.`);
  }

  const payload = await response.json();
  return Array.isArray(payload.docs) ? payload.docs : [];
}

async function searchGoogleVolumes(query, maxResults = 12) {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
    printType: 'books',
  });

  const response = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Books respondio ${response.status}.`);
  }

  const payload = await response.json();
  return Array.isArray(payload.items) ? payload.items : [];
}

async function findBookContext(book) {
  const openLibraryParams = new URLSearchParams({
    title: book.source?.matchedTitle || book.title,
    limit: '6',
  });

  if (book.author) {
    openLibraryParams.set('author', book.author);
  }

  const [olDocs, googleItems] = await Promise.all([
    searchOpenLibrary(openLibraryParams).catch(() => []),
    searchGoogleVolumes(
      book.author ? `intitle:${book.title} inauthor:${book.author}` : book.title,
      6
    ).catch(() => []),
  ]);

  const openLibraryCandidates = olDocs.map((doc) => toOpenLibraryCandidate(doc, book.author));
  const googleCandidates = googleItems.map((item) => toGoogleCandidate(item));

  const merged = [...openLibraryCandidates, ...googleCandidates]
    .filter((candidate) => candidate.title && !isNoisyCandidate(candidate))
    .map((candidate) => ({
      ...candidate,
      matchScore: scoreMatch(candidate, { title: book.title, author: book.author || '' }),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  return merged[0] || null;
}

async function buildRecommendationProfile(books) {
  const readTitles = new Set();
  const authorCounts = new Map();
  const subjectCounts = new Map();
  const keywordCounts = new Map();
  const contexts = await Promise.all(books.slice(0, 8).map((book) => findBookContext(book)));

  for (let index = 0; index < books.length; index += 1) {
    const book = books[index];
    const context = contexts[index];
    readTitles.add(normalizeKey(book.title));

    const authorKey = normalizeKey(book.author);
    if (authorKey) {
      authorCounts.set(book.author, (authorCounts.get(book.author) || 0) + 1);
    }

    const words = getMeaningfulTokens(book.title).filter((word) => !IGNORED_WORDS.has(word));

    for (const word of words) {
      keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
    }

    if (context) {
      const tags = [...(context.subjects || []), ...(context.categories || [])];
      for (const tag of tags) {
        const normalizedTag = normalizeText(tag);
        const normalizedKeyTag = normalizeKey(tag);
        if (!normalizedTag || normalizedKeyTag.length < 4) {
          continue;
        }

        subjectCounts.set(normalizedTag, (subjectCounts.get(normalizedTag) || 0) + 1);
      }

      const descriptionWords = getMeaningfulTokens(context.description)
        .filter((word) => !IGNORED_WORDS.has(word))
        .slice(0, 12);

      for (const word of descriptionWords) {
        keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
      }
    }
  }

  return {
    readTitles,
    topAuthors: trimAndRankEntries(authorCounts, 3),
    topSubjects: trimAndRankEntries(subjectCounts, 5),
    topKeywords: trimAndRankEntries(keywordCounts, 8),
  };
}

async function searchBooksByAuthor(author) {
  const params = new URLSearchParams({
    author,
    limit: '12',
  });

  const [docs, googleItems] = await Promise.all([
    searchOpenLibrary(params).catch(() => []),
    searchGoogleVolumes(`inauthor:${author}`, 10).catch(() => []),
  ]);

  return [
    ...docs.map((doc) => toOpenLibraryCandidate(doc, author)),
    ...googleItems.map((item) => toGoogleCandidate(item)),
  ];
}

async function searchBooksBySubject(subject) {
  const olParams = new URLSearchParams({
    subject,
    limit: '10',
  });

  const [olDocs, googleItems] = await Promise.all([
    searchOpenLibrary(olParams).catch(() => []),
    searchGoogleVolumes(`subject:${subject}`, 10).catch(() => []),
  ]);

  return [
    ...olDocs.map((doc) => toOpenLibraryCandidate(doc)),
    ...googleItems.map((item) => toGoogleCandidate(item)),
  ];
}

async function searchBooksBySimilarity(profile) {
  const query = [...profile.topSubjects.slice(0, 2).map(([subject]) => subject), ...profile.topKeywords.slice(0, 3).map(([keyword]) => keyword)].join(' ');

  if (!query) {
    return [];
  }

  const [olDocs, googleItems] = await Promise.all([
    searchOpenLibrary(new URLSearchParams({ q: query, limit: '10' })).catch(() => []),
    searchGoogleVolumes(query, 10).catch(() => []),
  ]);

  return [
    ...olDocs.map((doc) => toOpenLibraryCandidate(doc)),
    ...googleItems.map((item) => toGoogleCandidate(item)),
  ];
}

async function fetchRecommendationsFromBooks(books) {
  if (books.length === 0) {
    return [];
  }

  const profile = await buildRecommendationProfile(books);

  if (profile.topAuthors.length === 0 && profile.topSubjects.length === 0 && profile.topKeywords.length === 0) {
    return [];
  }

  const [authorGroups, subjectGroups, similarGroup] = await Promise.all([
    Promise.all(
      profile.topAuthors.map(async ([author, weight]) => ({
        author,
        weight,
        sourceType: 'author',
        items: await searchBooksByAuthor(author).catch(() => []),
      }))
    ),
    Promise.all(
      profile.topSubjects.map(async ([subject, weight]) => ({
        subject,
        weight,
        sourceType: 'subject',
        items: await searchBooksBySubject(subject).catch(() => []),
      }))
    ),
    searchBooksBySimilarity(profile).catch(() => []),
  ]);

  const authorWeights = new Map(profile.topAuthors.map(([author, weight]) => [normalizeKey(author), weight]));
  const subjectWeights = new Map(profile.topSubjects.map(([subject, weight]) => [normalizeKey(subject), weight]));
  const keywordTokens = profile.topKeywords.map(([keyword]) => keyword);
  const rawCandidates = [];

  for (const group of authorGroups) {
    for (const item of group.items) {
      rawCandidates.push({ ...item, seedType: 'author', seedWeight: group.weight, seedLabel: group.author });
    }
  }

  for (const group of subjectGroups) {
    for (const item of group.items) {
      rawCandidates.push({ ...item, seedType: 'subject', seedWeight: group.weight, seedLabel: group.subject });
    }
  }

  for (const item of similarGroup) {
    rawCandidates.push({ ...item, seedType: 'similarity', seedWeight: 1, seedLabel: 'similitud general' });
  }

  const scored = rawCandidates
    .filter((item) => item.title && !isNoisyCandidate(item))
    .filter((item) => !profile.readTitles.has(normalizeKey(item.title)))
    .map((item) => {
      const authorKey = normalizeKey(item.author);
      const topicText = `${item.title} ${(item.subjects || []).join(' ')} ${(item.categories || []).join(' ')} ${item.description || ''}`;
      const authorMatch = authorWeights.get(authorKey) || 0;
      const subjectHits = profile.topSubjects
        .filter(([subject]) => normalizeKey(topicText).includes(normalizeKey(subject)))
        .map(([subject]) => subject);
      const subjectScore = subjectHits.reduce(
        (sum, subject) => sum + (subjectWeights.get(normalizeKey(subject)) || 0),
        0
      );
      const keywordHits = keywordTokens.filter((keyword) => normalizeKey(topicText).includes(keyword));
      const similarityScore = countTokenMatches(topicText, keywordTokens);
      const diversityBoost = item.seedType === 'subject' ? 4 : item.seedType === 'similarity' ? 3 : 0;
      const sameAuthorPenalty = authorMatch > 0 && subjectScore === 0 && similarityScore < 2 ? 2 : 0;
      const score = authorMatch * 2 + subjectScore * 3 + similarityScore * 2 + diversityBoost - sameAuthorPenalty;

      let reason = 'Se parece a lo que vienes leyendo.';
      if (subjectHits.length > 0) {
        reason = `Coincide por genero o tema: ${subjectHits.slice(0, 2).join(', ')}`;
      } else if (keywordHits.length > 0) {
        reason = `Tiene una vibra parecida a tus lecturas: ${keywordHits.slice(0, 3).join(', ')}`;
      } else if (authorMatch > 0) {
        reason = `Tambien puede gustarte por cercania con ${item.author}`;
      }

      return {
        ...item,
        score,
        reason,
        subjectHits,
      };
    })
    .filter((item) => item.score > 0);

  const uniqueRecommendations = uniqueBy(
    scored.sort((a, b) => b.score - a.score),
    (item) => `${normalizeKey(item.title)}::${normalizeKey(item.author)}`
  );

  const limitedByAuthor = [];
  const authorUsage = new Map();

  for (const item of uniqueRecommendations) {
    const authorKey = normalizeKey(item.author);
    const used = authorUsage.get(authorKey) || 0;
    if (authorKey && used >= 2) {
      continue;
    }

    authorUsage.set(authorKey, used + 1);
    limitedByAuthor.push(item);
  }

  return limitedByAuthor.slice(0, 6).map((item) => ({
    title: item.title,
    author: item.author,
    pages: item.pages,
    firstPublishYear: item.firstPublishYear,
    subjects: (item.subjects || []).slice(0, 3),
    reason: item.reason,
    score: item.score,
    source: item.source,
  }));
}

function parseManualPages(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const pages = Number(value);
  if (!Number.isInteger(pages) || pages <= 0 || pages > 20000) {
    throw new Error('Las paginas manuales no son validas.');
  }

  return pages;
}

function parseYear(value) {
  if (!value) {
    return new Date().getFullYear();
  }

  const numericYear = Number(value);
  if (!Number.isInteger(numericYear) || numericYear < 1900 || numericYear > 3000) {
    throw new Error('El año no es válido.');
  }

  return numericYear;
}

app.get('/api/books', async (req, res) => {
  const clientId = getClientId(req);
  const store = await readStore();
  const books = getClientBooks(store, clientId);
  const year = req.query.year ? Number(req.query.year) : null;

  const filtered = Number.isInteger(year)
    ? books.filter((book) => book.year === year)
    : books;

  const ordered = filtered.sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));

  res.json(ordered);
});

app.get('/api/summary', async (req, res) => {
  const clientId = getClientId(req);
  const store = await readStore();
  const books = getClientBooks(store, clientId);
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

  const selected = books.filter((book) => book.year === year);
  const totalPages = selected.reduce((sum, book) => sum + book.pages, 0);

  res.json({
    year,
    booksRead: selected.length,
    totalPages,
  });
});

app.get('/api/suggestions', async (req, res) => {
  try {
    const query = normalizeText(req.query.q);

    if (query.length < 2) {
      return res.json([]);
    }

    const suggestions = await fetchSuggestions(query);
    res.json(suggestions);
  } catch (error) {
    res.status(400).json({ error: error.message || 'No se pudieron cargar sugerencias.' });
  }
});

app.get('/api/recommendations', async (req, res) => {
  try {
    const clientId = getClientId(req);
    const store = await readStore();
    const books = getClientBooks(store, clientId);
    const recommendations = await fetchRecommendationsFromBooks(books);

    res.json(recommendations);
  } catch (error) {
    console.error('Recommendation error:', error.message);
    res.json([]);
  }
});

app.post('/api/books', async (req, res) => {
  try {
    const clientId = getClientId(req);
    const title = normalizeText(req.body.title);
    const author = normalizeText(req.body.author);
    const finishedAt = req.body.finishedAt ? new Date(req.body.finishedAt) : new Date();
    const manualPages = parseManualPages(req.body.manualPages ?? req.body.pages);

    if (!title) {
      return res.status(400).json({ error: 'Debes ingresar el titulo del libro.' });
    }

    if (Number.isNaN(finishedAt.getTime())) {
      return res.status(400).json({ error: 'La fecha de finalizacion no es valida.' });
    }

    const year = parseYear(req.body.year || finishedAt.getFullYear());
    let resolved;

    try {
      resolved = await fetchBookPages({ title, author });
    } catch (lookupError) {
      if (!manualPages) {
        throw lookupError;
      }

      resolved = {
        pages: manualPages,
        sourceTitle: title,
        sourceAuthor: author || null,
        provider: 'Manual',
      };
    }

    const store = await readStore();
    const books = getClientBooks(store, clientId);

    const newBook = {
      id: crypto.randomUUID(),
      title,
      author: author || resolved.sourceAuthor || 'Autor no especificado',
      pages: resolved.pages,
      year,
      finishedAt: finishedAt.toISOString(),
      source: {
        provider: resolved.provider,
        matchedTitle: resolved.sourceTitle,
      },
      createdAt: new Date().toISOString(),
    };

    books.push(newBook);
    if (!store.byClient || typeof store.byClient !== 'object') {
      store.byClient = {};
    }
    store.byClient[clientId] = books;
    await writeStore(store);

    res.status(201).json(newBook);
  } catch (error) {
    res.status(400).json({ error: error.message || 'No se pudo guardar el libro.' });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    const clientId = getClientId(req);
    const bookId = normalizeText(req.params.id);

    if (!bookId) {
      return res.status(400).json({ error: 'Debes indicar el id del libro a borrar.' });
    }

    const store = await readStore();
    const books = getClientBooks(store, clientId);
    const next = books.filter((book) => book.id !== bookId);

    if (next.length === books.length) {
      return res.status(404).json({ error: 'No se encontro el libro para borrar.' });
    }

    store.byClient[clientId] = next;
    await writeStore(store);

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'No se pudo borrar el libro.' });
  }
});

app.listen(PORT, () => {
  console.log(`Bookyy corriendo en http://localhost:${PORT}`);
});
