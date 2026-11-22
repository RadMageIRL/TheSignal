// Regression fixture for a known limitation (Phase 3): cautious grouping splits one very large
// story into several groups when outlets word it differently. Modeled on a real capture's
// pattern (one arrest reported as "leader", "boss" and "kingpin"; "captured", "arrested" and
// "detained"; the suspect's name in several forms), with invented names, places and outlets.
// Decoys share a word or a place with the story but are different events and must never merge.
import type { Article } from '../../shared/types.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
let n = 0;
function a(sourceId: string, country: string, hoursAgo: number, title: string, story: 'arrest' | 'decoy' | 'filler'): Article & { story: string } {
  n++;
  return {
    id: `fr${n}`, sourceId, title, url: `https://${sourceId}.example/a/${n}`,
    publishedAt: new Date(NOW - hoursAgo * 3600_000).toISOString(), firstSeenAt: new Date(NOW).toISOString(),
    section: 'world', subsection: 'world-general', contentType: 'reporting', country, language: 'en', story,
  };
}

export function fragmentedStory(): (Article & { story: string })[] {
  n = 0;
  const arrest = [
    a('o1', 'US', 9, "Most wanted smuggling chief 'Lobo Velkoro' captured by Arvanian special forces", 'arrest'),
    a('o2', 'US', 8.5, 'Most wanted smuggling kingpin captured in Arvania', 'arrest'),
    a('o3', 'GB', 8, "At least 9 dead after suspected smuggling chief 'Lobo Velkoro' captured in Arvania", 'arrest'),
    a('o4', 'US', 7.5, 'Smuggling chief captured in northern Arvania in firefight that left 9 dead', 'arrest'),
    a('o5', 'HK', 7, 'Arvania captures smuggling kingpin on most wanted list in firefight', 'arrest'),
    a('o6', 'SG', 6.5, 'Arvania captures smuggling kingpin on most wanted list', 'arrest'),
    a('o7', 'FR', 6, "Arvania captures smuggling boss 'Lobo Velkoro' after deadly firefight", 'arrest'),
    a('o8', 'US', 5.5, "Arvania detains top smuggling boss 'Lobo Velkoro', setting off violence in the north", 'arrest'),
    a('o9', 'DE', 5, "Arvanian special forces arrest smuggling kingpin 'Lobo Velkoro'", 'arrest'),
    a('o10', 'US', 4.5, 'Who is the smuggling kingpin known as Lobo Velkoro?', 'arrest'),
    a('o11', 'QA', 4, "First images of Arvanian smuggling boss 'Lobo Velkoro' after arrest", 'arrest'),
    a('o12', 'IN', 3.5, 'Nine killed in burst of violence in northern Arvania after capture of smuggling chief', 'arrest'),
  ];
  const decoys = [
    a('d1', 'US', 6, 'Arvania port reopens after winter storm', 'decoy'),
    a('d2', 'GB', 5, 'Smuggling ring broken up at Dunmere airport, police say', 'decoy'),
    a('d3', 'CA', 4, 'Velkoro Bridge closes for repairs in Ostrava district', 'decoy'),
    a('d4', 'AU', 3, 'Special forces exercise planned near Kestrel border', 'decoy'),
  ];
  const fill = Array.from({ length: 140 }, (_, i) =>
    a(`f${i % 11}`, ['US', 'GB', 'IN', 'JP', 'BR'][i % 5]!, 1 + (i % 20), `Council item ${i} about zonebudget${i} and permit${i}`, 'filler'));
  return [...arrest, ...decoys, ...fill];
}
