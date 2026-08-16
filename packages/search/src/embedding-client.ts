import type OpenAI from 'openai'

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

export class FoundryEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly client: OpenAI,
    private readonly model = 'text-embedding-3-large',
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({ model: this.model, input: text })
    const embedding = response.data[0]?.embedding
    if (!embedding) {
      throw new Error('Embedding response did not contain a vector')
    }
    return embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }
    const response = await this.client.embeddings.create({ model: this.model, input: texts })
    return response.data
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding)
  }
}

export class FakeEmbeddingClient implements EmbeddingClient {
  embed(text: string): Promise<number[]> {
    void text
    return Promise.resolve(new Array<number>(3072).fill(0.1))
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => new Array<number>(3072).fill(0.1)))
  }
}
