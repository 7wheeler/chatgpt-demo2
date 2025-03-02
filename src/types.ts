export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image_url'
  image_url: {
    url: string
  }
}

export type MessageContent = TextContent | ImageContent

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | MessageContent[]
}

export interface ErrorMessage {
  code: string
  message: string
}
