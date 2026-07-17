export type ReviewComment = {
  id: string;
  file: CommentTarget;
  quote: string;
  note: string;
  lines?: DiffLineAnchor;
};

export type CommentTarget = {
  node: string;
  label: string;
};

export type DiffLineAnchor = {
  path: string;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  fragment: string;
};

export type DraftStagedAnswer =
  | { kind: 'question'; cardId: string; label: string; answer: string }
  | {
      kind: 'file';
      cardId: string;
      label: string;
      filename: string;
      content: string;
    }
  | { kind: 'secret'; cardId: string; label: string; valueEnc: string };

export type DraftPayload = {
  text: string;
  stagedAnswers: DraftStagedAnswer[];
  comments: ReviewComment[];
};
