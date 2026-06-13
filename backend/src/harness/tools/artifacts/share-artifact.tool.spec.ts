import type { ArtifactSink } from '@harness/surface/artifact-sink.port';
import type { HarnessToolContext } from '../tool.types';
import { ShareArtifactTool } from './share-artifact.tool';

const ctx: HarnessToolContext = {
  identity: {
    selfAgent: 'alex',
    team: 'T1',
    project: 'local',
    projects: ['local'],
    participants: [],
    speaker: 'dennis',
    surface: 'slack:T1:C1',
    isChannel: true,
  },
};

const args = {
  content: '# Analysis\nHere is the data.',
  filename: 'analysis.md',
  title: 'Analysis Report',
};

describe('ShareArtifactTool — no sink configured', () => {
  it('degrades gracefully and returns a warning string', async () => {
    const tool = new ShareArtifactTool(undefined);
    const result = await tool.execute(args, ctx);
    expect(result).toContain('No file upload adapter');
  });
});

describe('ShareArtifactTool — with sink', () => {
  it('returns a result string containing the file_id on success', async () => {
    const sink: ArtifactSink = {
      upload: vi.fn(async () => ({ fileId: 'F0ABCDEF' })),
    };
    const tool = new ShareArtifactTool(sink);
    const result = await tool.execute(args, ctx);

    expect(result).toContain('file_id: F0ABCDEF');
  });

  it('passes identity context (teamId, authorBotId) through to the sink', async () => {
    const sink: ArtifactSink = {
      upload: vi.fn(async () => ({ fileId: 'F1' })),
    };
    const tool = new ShareArtifactTool(sink);
    await tool.execute(args, ctx);

    expect(sink.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'T1',
        authorBotId: 'alex',
        content: args.content,
        filename: args.filename,
        title: args.title,
      }),
    );
  });

  it('returns fallback string when sink returns no fileId', async () => {
    const sink: ArtifactSink = {
      upload: vi.fn(async () => ({})),
    };
    const tool = new ShareArtifactTool(sink);
    const result = await tool.execute(args, ctx);

    expect(result).toContain('no file ID was returned');
  });

  it('title is omitted from upload request when not provided', async () => {
    const sink: ArtifactSink = {
      upload: vi.fn(async () => ({ fileId: 'F2' })),
    };
    const tool = new ShareArtifactTool(sink);
    await tool.execute({ content: 'x', filename: 'x.md' }, ctx);

    expect(sink.upload).toHaveBeenCalledWith(
      expect.objectContaining({ title: undefined }),
    );
  });
});
