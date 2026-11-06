'use strict';

// Pure identity diagnostic, not a userscript. No DOM, network, storage, credentials
// or playback operations occur here. "verified" means supplied snapshots agree;
// callers must establish response provenance/freshness before supplying them.
// resolveCatalogIdentity needs only context.courseId/context.catalogCourseId,
// catalog and dom; resolveLessonIdentity additionally checks the progress input.
// Input:
// {
//   context: { courseId, catalogCourseId, progressCourseId },
//   catalog: { code: 200, data: [ { id?, name, sort?, children: [
//     { id, name, sort?, tabVideo, tabWork?, tabExam?, tabFile?, tabVote?, subItems? }
//   ] } ] }, // data.list and one chapter object are also supported.
//   dom: { courseId, chapters: [ { title, chapterId?, nodes: [
//     { title, active: true|false, nodeId?, hasSubItems?: true|false }
//   ] } ] },
//   progress: { code: 200, data: { nodeProgressList: [ ... ] } }
// }
// DOM IDs must come from explicitly understood semantic attributes, never a
// framework key, generated element id, array position, or stale URL parameter.

function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

function identifier(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  // IDs are opaque. The site compares String(id), so stripping whitespace or
  // numeric-looking zeroes could merge identifiers the site treats as distinct.
  return typeof value === 'string' && value && value.trim() === value ? value : null;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknown(reason, details = {}) {
  return { status: 'unknown', reason, nodeId: null, ...details };
}

function sortValue(value) {
  if (value === undefined || value === null || value === '' || value === false) return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ordered(items) {
  if (items.some(item => !object(item) || sortValue(item.sort) === null)) return null;
  // The inspected site sorts by (sort || 0). Copy first to keep this API pure.
  return items.slice().sort((a, b) => sortValue(a.sort) - sortValue(b.sort));
}

function kindOf(node) {
  const kinds = [
    ['video', 'tabVideo'], ['work', 'tabWork'], ['exam', 'tabExam'],
    ['materials', 'tabFile'], ['externalLink', 'tabVote'],
  ].filter(([, flag]) => node[flag] === 1).map(([kind]) => kind);
  return kinds.length === 1 ? kinds[0] : kinds.length ? 'mixed' : 'unknown';
}

function groupsBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
}

function resolveCatalogIdentity(input) {
  if (!object(input) || !object(input.context) || !object(input.dom)) return unknown('invalid_input');
  const { context, catalog, dom } = input;
  const courseId = identifier(context.courseId);
  const contextIds = [context.catalogCourseId, dom.courseId].map(identifier);
  if (!courseId || contextIds.some(id => !id)) return unknown('course_context_missing');
  if (contextIds.some(id => id !== courseId)) return unknown('course_context_mismatch');
  if (!object(catalog) || catalog.code !== 200) {
    return unknown('response_not_successful');
  }
  if (catalog.courseId !== undefined && identifier(catalog.courseId) !== courseId) {
    return unknown('response_course_mismatch');
  }
  if (object(catalog.data) && catalog.data.courseId !== undefined && identifier(catalog.data.courseId) !== courseId) {
    return unknown('response_course_mismatch');
  }

  const rawChapters = Array.isArray(catalog.data) ? catalog.data
    : object(catalog.data) && Array.isArray(catalog.data.list) ? catalog.data.list
      : object(catalog.data) && Array.isArray(catalog.data.children) ? [catalog.data] : null;
  if (!rawChapters || !rawChapters.length) return unknown('catalog_chapters_missing');
  const chapters = ordered(rawChapters);
  if (!chapters) return unknown('catalog_sort_invalid');
  if (!Array.isArray(dom.chapters) || dom.chapters.length !== chapters.length) return unknown('chapter_count_mismatch');

  const chapterNames = groupsBy(chapters, chapter => normalizeText(chapter.name));
  const nodeIds = new Set();
  const chapterIds = new Set();
  const directory = [];
  const active = [];
  let directoryIndex = 0;

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    if (chapter.courseId !== undefined && identifier(chapter.courseId) !== courseId) {
      return unknown('catalog_chapter_course_mismatch', { chapterIndex });
    }
    const visibleChapter = dom.chapters[chapterIndex];
    const chapterTitle = normalizeText(chapter.name);
    const chapterId = chapter.id === undefined ? null : identifier(chapter.id);
    if (!chapterTitle) return unknown('catalog_chapter_title_missing', { chapterIndex });
    if (chapter.id !== undefined && !chapterId) return unknown('catalog_chapter_id_invalid', { chapterIndex });
    if (chapterId && chapterIds.has(chapterId)) return unknown('duplicate_chapter_id', { chapterIndex });
    if (chapterId) chapterIds.add(chapterId);
    if (!object(visibleChapter) || normalizeText(visibleChapter.title) !== chapterTitle) {
      return unknown('chapter_title_or_order_mismatch', { chapterIndex });
    }
    const visibleChapterId = visibleChapter.chapterId === undefined ? null : identifier(visibleChapter.chapterId);
    if (visibleChapter.chapterId !== undefined && (!visibleChapterId || visibleChapterId !== chapterId)) {
      return unknown('chapter_id_mismatch', { chapterIndex });
    }
    if (chapterNames.get(chapterTitle).length > 1 && !visibleChapterId) {
      return unknown('ambiguous_chapter_title', { chapterIndex });
    }
    if (chapter.children !== undefined && !Array.isArray(chapter.children)) return unknown('catalog_children_invalid', { chapterIndex });
    const nodes = ordered(chapter.children || []);
    if (!nodes) return unknown('catalog_sort_invalid', { chapterIndex });
    if (!Array.isArray(visibleChapter.nodes) || visibleChapter.nodes.length !== nodes.length) {
      return unknown('node_count_mismatch', { chapterIndex });
    }
    const titles = groupsBy(nodes, node => normalizeText(node.name));
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      if (node.courseId !== undefined && identifier(node.courseId) !== courseId) {
        return unknown('catalog_node_course_mismatch', { chapterIndex, nodeIndex });
      }
      const visible = visibleChapter.nodes[nodeIndex];
      const nodeId = identifier(node.id);
      const nodeTitle = normalizeText(node.name);
      const position = { chapterIndex, nodeIndex, directoryIndex };
      directoryIndex += 1;
      if (!nodeId) return unknown('catalog_node_id_invalid', position);
      if (nodeIds.has(nodeId)) return unknown('duplicate_node_id', position);
      nodeIds.add(nodeId);
      if (!nodeTitle) return unknown('catalog_node_title_missing', position);
      if (!object(visible) || normalizeText(visible.title) !== nodeTitle) return unknown('node_title_or_order_mismatch', position);
      if (typeof visible.active !== 'boolean') return unknown('dom_active_state_invalid', position);
      const visibleId = visible.nodeId === undefined ? null : identifier(visible.nodeId);
      if (visible.nodeId !== undefined && (!visibleId || visibleId !== nodeId)) return unknown('dom_node_id_mismatch', position);
      if (titles.get(nodeTitle).length > 1 && !visibleId) return unknown('ambiguous_node_title', position);
      if (node.subItems !== undefined && node.subItems !== null && !Array.isArray(node.subItems)) {
        return unknown('catalog_subitems_invalid', position);
      }
      if (visible.hasSubItems !== undefined && typeof visible.hasSubItems !== 'boolean') {
        return unknown('dom_subitems_invalid', position);
      }
      const entry = { ...position, nodeId, chapterId, chapterTitle, nodeTitle, title: nodeTitle,
        kind: kindOf(node), hasSubItems: Boolean(node.subItems?.length || visible.hasSubItems) };
      directory.push(entry);
      if (visible.active) active.push(entry);
    }
  }
  if (active.length !== 1) return unknown('active_node_not_unique', { activeCount: active.length });
  const selected = active[0];
  if (selected.hasSubItems) return unknown('active_subitems_unsupported');
  if (selected.kind === 'mixed' || selected.kind === 'unknown') return unknown('active_kind_ambiguous');
  if (selected.kind !== 'video') return unknown('active_not_video', { kind: selected.kind });

  // Keep every validated entry, including non-video/unsupported next nodes.
  // A playback caller must decide whether to stop; this resolver never skips.
  return {
    status: 'verified', reason: 'catalog_dom_agree', source: 'catalog-dom', courseId,
    ...selected, directory,
  };
}

module.exports = resolveCatalogIdentity;
