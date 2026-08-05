export type GapKind =
  | 'unsupported-platform'
  | 'no-backend-detected'
  | 'unknown-quant'
  | 'backend-response-unexpected'
  | 'scrape-failed';

export interface Gap {
  kind: GapKind;
  summary: string;
  evidence: Record<string, unknown>;
}

export class GapCollector {
  private gaps: Gap[] = [];

  add(gap: Gap): void {
    if (this.gaps.some((g) => g.kind === gap.kind && g.summary === gap.summary)) return;
    this.gaps.push(gap);
  }

  list(): Gap[] {
    return [...this.gaps];
  }
}
