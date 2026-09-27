export interface DocsLabels {
  search: string; results: string; empty: string; failed: string;
  repository: string; skip: string; navigation: string; contents: string;
}
const rows: Record<string, string[]> = {
  en: ['Search', 'Search results', 'No results', 'Search unavailable; please retry.', 'Repository', 'Skip to content', 'Documentation', 'On this page'],
  zh: ['搜索', '搜索结果', '没有找到结果', '搜索暂不可用，请重试。', '代码仓库', '跳至正文', '文档导航', '本页目录'],
  'zh-Hant': ['搜尋', '搜尋結果', '沒有找到結果', '搜尋暫不可用，請重試。', '程式碼倉庫', '跳至正文', '文件導覽', '本頁目錄'],
  de: ['Suchen', 'Suchergebnisse', 'Keine Ergebnisse', 'Suche nicht verfügbar. Bitte erneut versuchen.', 'Repository', 'Zum Inhalt springen', 'Dokumentation', 'Auf dieser Seite'],
  fr: ['Rechercher', 'Résultats de recherche', 'Aucun résultat', 'Recherche indisponible. Veuillez réessayer.', 'Dépôt', 'Aller au contenu', 'Documentation', 'Sur cette page'],
  it: ['Cerca', 'Risultati della ricerca', 'Nessun risultato', 'Ricerca non disponibile. Riprova.', 'Repository', 'Vai al contenuto', 'Documentazione', 'In questa pagina'],
  hu: ['Keresés', 'Keresési eredmények', 'Nincs találat', 'A keresés nem érhető el. Próbálja újra.', 'Forráskód', 'Ugrás a tartalomhoz', 'Dokumentáció', 'Ezen az oldalon'],
};
export function docsLabels(language: string): DocsLabels {
  const [search, results, empty, failed, repository, skip, navigation, contents] = rows[language] ?? rows.en;
  return { search, results, empty, failed, repository, skip, navigation, contents };
}
