const yearSelect = document.getElementById('yearSelect');
const totalPagesEl = document.getElementById('totalPages');
const bookCountEl = document.getElementById('bookCount');
const bookForm = document.getElementById('bookForm');
const titleInput = document.getElementById('titleInput');
const titleSuggestions = document.getElementById('titleSuggestions');
const authorInput = document.getElementById('authorInput');
const finishedAtInput = document.getElementById('finishedAtInput');
const manualPagesInput = document.getElementById('manualPagesInput');
const formMessage = document.getElementById('formMessage');
const bookList = document.getElementById('bookList');
const recommendationList = document.getElementById('recommendationList');
const homeView = document.getElementById('homeView');
const booksView = document.getElementById('booksView');
const menuToggle = document.getElementById('menuToggle');
const menuClose = document.getElementById('menuClose');
const navDrawer = document.getElementById('navDrawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const drawerLinks = Array.from(document.querySelectorAll('.drawer-link'));

const STORE_KEY = 'bookyyStoreV1';
const CLIENT_KEY = 'bookyyClientId';
const DEFAULT_CLIENT_ID = 'legacy';

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

const clientId = getOrCreateClientId();
let suggestionTimer;
let currentSuggestions = [];
let activeSuggestionIndex = -1;

function normalizeText(value) {
  return (value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function getMeaningfulTokens(value) {
  return normalizeKey(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
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

function countTokenMatches(text, tokens) {
  const haystack = normalizeKey(text);
  return tokens.filter((token) => haystack.includes(token)).length;
}

function trimAndRankEntries(counter, limit) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
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
    throw new Error('El año no es valido.');
  }

  return numericYear;
}

function getOrCreateClientId() {
  const existing = window.localStorage.getItem(CLIENT_KEY);
  if (existing) {
    return existing;
  }

  const generated =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  window.localStorage.setItem(CLIENT_KEY, generated);
  return generated;
}

function readStore() {
  const raw = window.localStorage.getItem(STORE_KEY);

  if (!raw) {
    return { byClient: {} };
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return { byClient: { [DEFAULT_CLIENT_ID]: parsed } };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { byClient: {} };
    }

    if (!parsed.byClient || typeof parsed.byClient !== 'object') {
      return { byClient: {} };
    }

    return parsed;
  } catch {
    return { byClient: {} };
  }
}

function writeStore(store) {
  window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function getClientBooks(store, activeClientId) {
  const books = store.byClient?.[activeClientId];
  return Array.isArray(books) ? books : [];
}

function getBooksForYear(year) {
  const store = readStore();
  const books = getClientBooks(store, clientId);
  return books
    .filter((book) => book.year === year)
    .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
}

function getSummaryForYear(year) {
  const books = getBooksForYear(year);
  const totalPages = books.reduce((sum, book) => sum + book.pages, 0);

  return {
    year,
    booksRead: books.length,
    totalPages,
  };
}

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

function scoreMatch(candidate, { title, author }) {
  const exactTitle = normalizeKey(title);
  const exactAuthor = normalizeKey(author);
  const candidateTitle = normalizeKey(candidate.title || '');
  const candidateAuthor = normalizeKey(candidate.author || '');

  const titleScore = candidateTitle === exactTitle ? 2 : candidateTitle.includes(exactTitle) ? 1 : 0;
  const authorScore = exactAuthor && candidateAuthor ? (candidateAuthor.includes(exactAuthor) ? 1 : 0) : 0;

  return titleScore + authorScore;
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

async function fetchFromOpenLibrary({ title, author }) {
  const params = new URLSearchParams({
    title,
    limit: '10',
  });

  if (author) {
    params.set('author', author);
  }

  const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
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

  const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
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

  return ranked.slice(0, 6).map((item) => ({
    title: item.title,
    author: item.author,
    pages: item.pages,
    source: item.source,
  }));
}

async function searchOpenLibrary(params) {
  const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);

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
    searchGoogleVolumes(book.author ? `intitle:${book.title} inauthor:${book.author}` : book.title, 6).catch(
      () => []
    ),
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

  return [...docs.map((doc) => toOpenLibraryCandidate(doc, author)), ...googleItems.map((item) => toGoogleCandidate(item))];
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

  return [...olDocs.map((doc) => toOpenLibraryCandidate(doc)), ...googleItems.map((item) => toGoogleCandidate(item))];
}

async function searchBooksBySimilarity(profile) {
  const query = [
    ...profile.topSubjects.slice(0, 2).map(([subject]) => subject),
    ...profile.topKeywords.slice(0, 3).map(([keyword]) => keyword),
  ].join(' ');

  if (!query) {
    return [];
  }

  const [olDocs, googleItems] = await Promise.all([
    searchOpenLibrary(new URLSearchParams({ q: query, limit: '10' })).catch(() => []),
    searchGoogleVolumes(query, 10).catch(() => []),
  ]);

  return [...olDocs.map((doc) => toOpenLibraryCandidate(doc)), ...googleItems.map((item) => toGoogleCandidate(item))];
}

async function fetchRecommendations() {
  const store = readStore();
  const books = getClientBooks(store, clientId);

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
        items: await searchBooksByAuthor(author).catch(() => []),
      }))
    ),
    Promise.all(
      profile.topSubjects.map(async ([subject, weight]) => ({
        subject,
        weight,
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

function openDrawer() {
  navDrawer.classList.add('is-open');
  drawerBackdrop.classList.add('is-open');
  navDrawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  navDrawer.classList.remove('is-open');
  drawerBackdrop.classList.remove('is-open');
  navDrawer.setAttribute('aria-hidden', 'true');
}

function setView(view) {
  const showHome = view === 'home';
  homeView.classList.toggle('is-hidden', !showHome);
  booksView.classList.toggle('is-hidden', showHome);

  drawerLinks.forEach((link) => {
    link.classList.toggle('is-active', link.dataset.view === view);
  });

  closeDrawer();
}

function formatDate(input) {
  const date = new Date(input);
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function setMessage(text, isError = false) {
  formMessage.textContent = text;
  formMessage.style.color = isError ? '#8a3009' : '#1f5f4f';
}

function fillYearOptions() {
  const current = new Date().getFullYear();
  yearSelect.innerHTML = '';

  for (let year = current + 1; year >= current - 10; year -= 1) {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = String(year);
    if (year === current) {
      option.selected = true;
    }
    yearSelect.append(option);
  }
}

function renderSuggestions(suggestions) {
  titleSuggestions.innerHTML = '';
  currentSuggestions = suggestions;
  activeSuggestionIndex = -1;

  if (suggestions.length === 0) {
    titleSuggestions.classList.remove('is-open');
    titleInput.setAttribute('aria-expanded', 'false');
    return;
  }

  suggestions.forEach((suggestion, index) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-item';
    button.dataset.index = String(index);

    const title = document.createElement('span');
    title.className = 'suggestion-title';
    title.textContent = suggestion.title;

    const meta = document.createElement('span');
    meta.className = 'suggestion-meta';
    const metaParts = [];
    if (suggestion.author) {
      metaParts.push(suggestion.author);
    }
    if (suggestion.pages) {
      metaParts.push(`${suggestion.pages} paginas`);
    }
    if (suggestion.source) {
      metaParts.push(suggestion.source);
    }
    meta.textContent = metaParts.join(' · ');

    button.append(title, meta);
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applySuggestion(index);
    });

    item.append(button);
    titleSuggestions.append(item);
  });

  titleSuggestions.classList.add('is-open');
  titleInput.setAttribute('aria-expanded', 'true');
}

function closeSuggestions() {
  titleSuggestions.classList.remove('is-open');
  titleInput.setAttribute('aria-expanded', 'false');
  activeSuggestionIndex = -1;
}

function updateActiveSuggestion() {
  const buttons = titleSuggestions.querySelectorAll('.suggestion-item');
  buttons.forEach((button, index) => {
    button.classList.toggle('is-active', index === activeSuggestionIndex);
  });
}

function applySuggestion(index) {
  const suggestion = currentSuggestions[index];
  if (!suggestion) {
    return;
  }

  titleInput.value = suggestion.title;
  if (suggestion.author) {
    authorInput.value = suggestion.author;
  }
  closeSuggestions();
}

function onTitleInput() {
  clearTimeout(suggestionTimer);
  const query = titleInput.value.trim();

  if (query.length < 2) {
    renderSuggestions([]);
    return;
  }

  suggestionTimer = setTimeout(async () => {
    try {
      const suggestions = await fetchSuggestions(query);
      renderSuggestions(suggestions);
    } catch {
      renderSuggestions([]);
    }
  }, 240);
}

function onTitleKeyDown(event) {
  if (event.key === 'Escape') {
    closeSuggestions();
    return;
  }

  if (!titleSuggestions.classList.contains('is-open') || currentSuggestions.length === 0) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, currentSuggestions.length - 1);
    updateActiveSuggestion();
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
    updateActiveSuggestion();
    return;
  }

  if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
    event.preventDefault();
    applySuggestion(activeSuggestionIndex);
  }
}

function deleteBook(bookId) {
  const store = readStore();
  const books = getClientBooks(store, clientId);
  const next = books.filter((book) => book.id !== bookId);

  if (next.length === books.length) {
    throw new Error('No se encontro el libro para borrar.');
  }

  store.byClient[clientId] = next;
  writeStore(store);
}

function renderBooks(books) {
  bookList.innerHTML = '';

  if (books.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'Todavia no registraste libros para este año.';
    bookList.append(empty);
    return;
  }

  for (const book of books) {
    const item = document.createElement('li');
    item.className = 'book-item';

    const title = document.createElement('h3');
    title.textContent = `${book.title} - ${book.author}`;

    const date = document.createElement('p');
    date.textContent = `Terminado: ${formatDate(book.finishedAt)}`;

    const pages = document.createElement('p');
    pages.className = 'book-pages';
    pages.textContent = `${book.pages} paginas`;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'book-delete';
    removeButton.textContent = 'Borrar';
    removeButton.addEventListener('click', async () => {
      try {
        deleteBook(book.id);
        setMessage('Libro borrado correctamente.');
        await refreshDashboardAndRecommendations();
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    item.append(title, pages, date, removeButton);
    bookList.append(item);
  }
}

function renderRecommendations(recommendations) {
  recommendationList.innerHTML = '';

  if (recommendations.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'Carga algunos libros y te voy a recomendar otros parecidos.';
    recommendationList.append(empty);
    return;
  }

  for (const recommendation of recommendations) {
    const item = document.createElement('li');
    item.className = 'recommendation-item';

    const heading = document.createElement('h3');
    heading.textContent = `${recommendation.title} - ${recommendation.author}`;

    const reason = document.createElement('p');
    reason.textContent = recommendation.reason;

    const meta = document.createElement('p');
    const bits = [];
    if (recommendation.firstPublishYear) {
      bits.push(`Primera edicion: ${recommendation.firstPublishYear}`);
    }
    if (recommendation.pages) {
      bits.push(`${recommendation.pages} paginas aprox.`);
    }
    if (Array.isArray(recommendation.subjects) && recommendation.subjects.length > 0) {
      bits.push(`Temas: ${recommendation.subjects.join(', ')}`);
    }
    meta.textContent = bits.join(' · ');

    item.append(heading, reason, meta);
    recommendationList.append(item);
  }
}

async function refreshRecommendations() {
  try {
    const recommendations = await fetchRecommendations();
    renderRecommendations(recommendations);
  } catch {
    renderRecommendations([]);
  }
}

async function refreshDashboard(year = Number(yearSelect.value)) {
  const summary = getSummaryForYear(year);
  const books = getBooksForYear(year);

  totalPagesEl.textContent = String(summary.totalPages);
  bookCountEl.textContent = String(summary.booksRead);
  renderBooks(books);
}

async function refreshAll(year = Number(yearSelect.value)) {
  await refreshDashboard(year);
  await refreshRecommendations();
}

function onYearChange() {
  const selectedYear = Number(yearSelect.value);
  refreshDashboard(selectedYear).catch((error) => setMessage(error.message, true));
}

async function refreshDashboardAndRecommendations(year = Number(yearSelect.value)) {
  await refreshDashboard(year);
  await refreshRecommendations();
}

function saveBook(book) {
  const store = readStore();
  const books = getClientBooks(store, clientId);
  books.push(book);

  if (!store.byClient || typeof store.byClient !== 'object') {
    store.byClient = {};
  }

  store.byClient[clientId] = books;
  writeStore(store);
}

async function submitBook(event) {
  event.preventDefault();
  setMessage('Buscando paginas y guardando en este navegador...');

  try {
    const title = normalizeText(titleInput.value);
    const author = normalizeText(authorInput.value);
    const finishedAt = finishedAtInput.value ? new Date(finishedAtInput.value) : new Date();
    const manualPages = parseManualPages(manualPagesInput.value);

    if (!title) {
      throw new Error('Debes ingresar el titulo del libro.');
    }

    if (Number.isNaN(finishedAt.getTime())) {
      throw new Error('La fecha de finalizacion no es valida.');
    }

    const year = parseYear(yearSelect.value || finishedAt.getFullYear());
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

    const newBook = {
      id:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

    saveBook(newBook);

    setMessage(`Listo: ${newBook.title} sumo ${newBook.pages} paginas (${newBook.source.provider}).`);
    bookForm.reset();
    finishedAtInput.value = new Date().toISOString().slice(0, 10);
    closeSuggestions();
    renderSuggestions([]);
    await refreshDashboardAndRecommendations();
  } catch (error) {
    setMessage(error.message || 'No se pudo guardar el libro.', true);
  }
}

function setInitialDate() {
  finishedAtInput.value = new Date().toISOString().slice(0, 10);
}

fillYearOptions();
setInitialDate();
refreshAll().catch((error) => {
  setMessage(error.message, true);
});
setView('home');

yearSelect.addEventListener('change', onYearChange);
titleInput.addEventListener('input', onTitleInput);
titleInput.addEventListener('keydown', onTitleKeyDown);
titleInput.addEventListener('blur', () => {
  window.setTimeout(closeSuggestions, 120);
});
menuToggle.addEventListener('click', openDrawer);
menuClose.addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);
drawerLinks.forEach((link) => {
  link.addEventListener('click', () => {
    setView(link.dataset.view === 'books' ? 'books' : 'home');
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeDrawer();
  }
});
bookForm.addEventListener('submit', submitBook);
