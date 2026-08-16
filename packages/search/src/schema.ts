export const FINDING_INDEX_NAME = 'findings-index'

export const findingIndexSchema = {
  name: FINDING_INDEX_NAME,
  fields: [
    { name: 'id', type: 'Edm.String', key: true, searchable: false },
    { name: 'tenantId', type: 'Edm.String', filterable: true, searchable: false },
    {
      name: 'title',
      type: 'Edm.String',
      searchable: true,
      analyzerName: 'standard.lucene',
    },
    {
      name: 'summary',
      type: 'Edm.String',
      searchable: true,
      analyzerName: 'standard.lucene',
    },
    { name: 'severity', type: 'Edm.String', filterable: true, facetable: true },
    { name: 'recommendation', type: 'Edm.String', searchable: true },
    { name: 'owner', type: 'Edm.String', filterable: true },
    { name: 'detectedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
    {
      name: 'contentVector',
      type: 'Collection(Edm.Single)',
      searchable: true,
      dimensions: 3072,
      vectorSearchProfile: 'finding-profile',
    },
  ],
  vectorSearch: {
    profiles: [{ name: 'finding-profile', algorithmConfigurationName: 'hnsw-config' }],
    algorithms: [
      {
        name: 'hnsw-config',
        kind: 'hnsw',
        parameters: { m: 4, efConstruction: 400, metric: 'cosine' },
      },
    ],
  },
} as const
