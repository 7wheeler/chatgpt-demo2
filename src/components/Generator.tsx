import { Index, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { useThrottleFn } from 'solidjs-use'
import { generateSignature } from '@/utils/auth'
import IconClear from './icons/Clear'
import IconImage from './icons/Image'
import MessageItem from './MessageItem'
import SystemRoleSettings from './SystemRoleSettings'
import ErrorMessageItem from './ErrorMessageItem'
import type { ChatMessage, ErrorMessage } from '@/types'
import './ChatPage.css'

type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export default function ChatPage() {
  let inputRef!: HTMLTextAreaElement
  let fileInputRef!: HTMLInputElement
  let disposed = false

  const [currentSystemRoleSettings, setCurrentSystemRoleSettings] = createSignal('')
  const [systemRoleEditing, setSystemRoleEditing] = createSignal(false)
  const [messageList, setMessageList] = createSignal<ChatMessage[]>([])
  const [currentError, setCurrentError] = createSignal<ErrorMessage | null>(null)
  const [requestError, setRequestError] = createSignal('')
  const [currentAssistantMessage, setCurrentAssistantMessage] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [controller, setController] = createSignal<AbortController | null>(null)
  const [selectedImages, setSelectedImages] = createSignal<string[]>([])

  const smoothToBottom = useThrottleFn(() => {
    if (!disposed) {
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, 300, false, true)

  const persistState = () => {
    try {
      localStorage.setItem('messageList', JSON.stringify(messageList()))
      localStorage.setItem('systemRoleSettings', currentSystemRoleSettings())
    } catch (error) {
      console.error('Unable to save chat history:', error)
    }
  }

  const restoreState = () => {
    try {
      const storedMessages = localStorage.getItem('messageList')
      const storedSystemRole = localStorage.getItem('systemRoleSettings')

      if (storedMessages) {
        const parsed = JSON.parse(storedMessages)
        if (Array.isArray(parsed))
          setMessageList(parsed)
      }

      if (storedSystemRole)
        setCurrentSystemRoleSettings(storedSystemRole)
    } catch (error) {
      console.error('Unable to restore chat history:', error)
    }
  }

  onMount(() => {
    restoreState()
    window.addEventListener('beforeunload', persistState)
  })

  onCleanup(() => {
    disposed = true
    controller()?.abort()

    if (typeof window !== 'undefined')
      window.removeEventListener('beforeunload', persistState)
  })

  const resetTextareaHeight = () => {
    if (inputRef)
      inputRef.style.height = 'auto'
  }

  const autosizeTextarea = () => {
    if (!inputRef)
      return

    inputRef.style.height = 'auto'
    inputRef.style.height = `${Math.min(inputRef.scrollHeight, 220)}px`
  }

  const focusInput = () => {
    if (!disposed)
      inputRef?.focus()
  }

  const openFilePicker = () => {
    if (!loading() && !systemRoleEditing())
      fileInputRef?.click()
  }

  const removeImage = (index: number) => {
    setSelectedImages(previous => previous.filter((_, i) => i !== index))
  }

  const useStarter = (text: string) => {
    if (loading() || systemRoleEditing())
      return

    inputRef.value = text
    autosizeTextarea()
    focusInput()
  }

  const buildUserMessage = (text: string, images: string[]): ChatMessage => {
    if (images.length === 0) {
      return {
        role: 'user',
        content: text,
      }
    }

    const content: MessageContentPart[] = [
      { type: 'text', text: text || 'Analyze this image' },
      ...images.map(url => ({
        type: 'image_url' as const,
        image_url: { url },
      })),
    ]

    return {
      role: 'user',
      content,
    }
  }

  const buildRequestMessages = () => {
    const messages = [...messageList()]

    if (currentSystemRoleSettings()) {
      messages.unshift({
        role: 'system',
        content: currentSystemRoleSettings(),
      })
    }

    return messages
  }

  const extractSignatureMessage = (message: ChatMessage | undefined) => {
    if (!message)
      return ''

    if (typeof message.content === 'string')
      return message.content

    if (Array.isArray(message.content)) {
      const textPart = message.content.find(item => item.type === 'text')
      if (textPart && 'text' in textPart)
        return textPart.text
    }

    return ''
  }

  const archiveCurrentMessage = () => {
    const assistantText = currentAssistantMessage()

    if (assistantText) {
      setMessageList(previous => [
        ...previous,
        {
          role: 'assistant',
          content: assistantText,
        },
      ])
    }

    setCurrentAssistantMessage('')
    setLoading(false)
    setController(null)
    persistState()
    focusInput()
  }

  const streamAssistantResponse = async (response: Response) => {
    if (!response.body)
      throw new Error('The server returned an empty response.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')

    try {
      while (true) {
        const { value, done } = await reader.read()

        if (done)
          break

        if (disposed)
          return

        const chunk = decoder.decode(value, { stream: true })

        if (chunk) {
          setCurrentAssistantMessage(previous => previous + chunk)
          smoothToBottom()
        }
      }

      const remaining = decoder.decode()
      if (remaining && !disposed)
        setCurrentAssistantMessage(previous => previous + remaining)
    } finally {
      reader.releaseLock()
    }
  }

  const requestWithLatestMessage = async () => {
    if (loading() || disposed)
      return

    setLoading(true)
    setCurrentAssistantMessage('')
    setCurrentError(null)
    setRequestError('')

    const abortController = new AbortController()
    setController(abortController)

    try {
      const requestMessages = buildRequestMessages()
      const timestamp = Date.now()
      const lastMessage = requestMessages[requestMessages.length - 1]

      const response = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          messages: requestMessages,
          time: timestamp,
          pass: localStorage.getItem('pass'),
          sign: await generateSignature({
            t: timestamp,
            m: extractSignatureMessage(lastMessage),
          }),
        }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const error = await response.json().catch(() => null)

        if (error?.error)
          setCurrentError(error.error)
        else
          setRequestError(`Request failed (${response.status}). Please try again.`)

        return
      }

      await streamAssistantResponse(response)
    } catch (error) {
      if (!abortController.signal.aborted && !disposed) {
        console.error(error)
        setRequestError(
          error instanceof Error
            ? error.message
            : 'Something went wrong. Please try again.',
        )
      }
    } finally {
      if (!disposed)
        archiveCurrentMessage()
    }
  }

  const sendMessage = async () => {
    if (loading() || systemRoleEditing())
      return

    const text = inputRef.value.trim()
    const images = selectedImages()

    if (!text && images.length === 0)
      return

    try {
      const analyticsWindow = window as Window & {
        umami?: { trackEvent?: (event: string) => void }
      }
      analyticsWindow.umami?.trackEvent?.('chat_generate')
    } catch {
      // Analytics should never prevent sending a message.
    }

    setMessageList(previous => [
      ...previous,
      buildUserMessage(text, images),
    ])

    setSelectedImages([])
    inputRef.value = ''
    resetTextareaHeight()
    smoothToBottom()

    await requestWithLatestMessage()
  }

  const clearChat = () => {
    if (loading() || systemRoleEditing())
      return

    if (!window.confirm('Clear this conversation?'))
      return

    inputRef.value = ''
    resetTextareaHeight()
    setMessageList([])
    setCurrentAssistantMessage('')
    setCurrentError(null)
    setRequestError('')
    setSelectedImages([])
    persistState()
    focusInput()
  }

  const stopStreamFetch = () => {
    controller()?.abort()
  }

  const retryLastFetch = () => {
    if (loading() || systemRoleEditing())
      return

    const messages = messageList()
    if (messages.length === 0)
      return

    const lastMessage = messages[messages.length - 1]

    if (lastMessage.role === 'assistant')
      setMessageList(messages.slice(0, -1))

    void requestWithLatestMessage()
  }

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.shiftKey)
      return

    if (event.key === 'Enter') {
      event.preventDefault()
      void sendMessage()
    }
  }

  const handleFileUpload = (event: Event) => {
    const files = (event.target as HTMLInputElement).files
    if (!files?.length)
      return

    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/'))
        return

      const reader = new FileReader()

      reader.onload = () => {
        if (disposed || typeof reader.result !== 'string')
          return

        const image = reader.result
        setSelectedImages(previous => [...previous, image])
      }

      reader.onerror = () => {
        if (!disposed)
          setRequestError('Unable to read that image. Please try another file.')
      }

      reader.readAsDataURL(file)
    })

    fileInputRef.value = ''
  }

  const hasConversation = () =>
    messageList().length > 0
    || selectedImages().length > 0
    || !!currentError()
    || !!requestError()

  return (
    <section class="ym-chat" aria-label="AI chat workspace">
      <div class="ym-settings">
        <SystemRoleSettings
          canEdit={() => messageList().length === 0 && !loading()}
          systemRoleEditing={systemRoleEditing}
          setSystemRoleEditing={setSystemRoleEditing}
          currentSystemRoleSettings={currentSystemRoleSettings}
          setCurrentSystemRoleSettings={setCurrentSystemRoleSettings}
        />
      </div>

      <div class="ym-panel">
        <header class="ym-panel-header">
          <div class="ym-panel-title">
            <span class="ym-brand-dot" aria-hidden="true" />
            Your AI workspace
          </div>
          <span class="ym-panel-label">CHAT + IMAGES</span>
        </header>

        <div class="ym-conversation">
          <Show when={messageList().length === 0 && !loading()}>
            <div class="ym-welcome">
              <div class="ym-welcome-icon" aria-hidden="true">✦</div>

              <span class="ym-eyebrow">A LITTLE HELP. MORE POSSIBILITY.</span>
              <h2>What will you create today?</h2>

              <p>
                Bring an idea, ask a question, or share an image.
                Let’s make something good.
              </p>

              <div class="ym-starters">
                <button
                  type="button"
                  disabled={systemRoleEditing()}
                  onClick={() => useStarter('Help me brainstorm ideas for ')}
                >
                  <span aria-hidden="true">✧</span>
                  Brainstorm ideas
                </button>

                <button
                  type="button"
                  disabled={systemRoleEditing()}
                  onClick={() => useStarter('Help me write a first draft of ')}
                >
                  <span aria-hidden="true">✎</span>
                  Write something
                </button>

                <button
                  type="button"
                  disabled={systemRoleEditing()}
                  onClick={() => useStarter('Explain this in simple terms: ')}
                >
                  <span aria-hidden="true">◎</span>
                  Learn something
                </button>
              </div>
            </div>
          </Show>

          <Index each={messageList()}>
            {(message, index) => (
              <MessageItem
                role={message().role}
                message={message().content}
                showRetry={() =>
                  !loading()
                  && message().role === 'assistant'
                  && index === messageList().length - 1
                }
                onRetry={retryLastFetch}
              />
            )}
          </Index>

          <Show when={currentAssistantMessage()}>
            <MessageItem
              role="assistant"
              message={currentAssistantMessage}
            />
          </Show>

          <Show when={currentError()}>
            <ErrorMessageItem
              data={currentError()!}
              onRetry={retryLastFetch}
            />
          </Show>

          <Show when={requestError()}>
            <div class="ym-error" role="alert">
              <span>{requestError()}</span>
              <Show when={messageList().length > 0}>
                <button
                  type="button"
                  onClick={retryLastFetch}
                  disabled={loading()}
                >
                  Try again
                </button>
              </Show>
            </div>
          </Show>

          <Show when={loading()}>
            <div class="ym-status" role="status">
              <span aria-hidden="true" />
              {currentAssistantMessage() ? 'Writing a response…' : 'Thinking…'}
            </div>
          </Show>
        </div>

        <div class="ym-composer-area">
          <Show when={selectedImages().length > 0}>
            <div class="ym-attachments" aria-label="Attached images">
              <Index each={selectedImages()}>
                {(imageUrl, index) => (
                  <div class="ym-attachment">
                    <img
                      src={imageUrl()}
                      alt={`Attachment ${index + 1}`}
                    />
                    <button
                      type="button"
                      aria-label={`Remove attachment ${index + 1}`}
                      onClick={() => removeImage(index)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </Index>
            </div>
          </Show>

          <div
            class="ym-composer"
            classList={{ 'ym-disabled': systemRoleEditing() }}
          >
            <textarea
              ref={inputRef!}
              aria-label="Your message"
              aria-describedby="ym-input-hint"
              disabled={systemRoleEditing() || loading()}
              onKeyDown={handleKeydown}
              onInput={autosizeTextarea}
              placeholder="Ask anything, or share an image…"
              autocomplete="off"
              rows={2}
            />

            <div class="ym-toolbar">
              <button
                type="button"
                class="ym-upload"
                title="Attach images"
                aria-label="Attach images"
                onClick={openFilePicker}
                disabled={systemRoleEditing() || loading()}
              >
                <IconImage />
                <span>Add image</span>
              </button>

              <input
                type="file"
                ref={fileInputRef!}
                accept="image/*"
                multiple
                hidden
                onChange={handleFileUpload}
              />

              <Show
                when={!loading()}
                fallback={
                  <button
                    type="button"
                    class="ym-send"
                    onClick={stopStreamFetch}
                  >
                    Stop response
                    <span class="ym-stop-icon" aria-hidden="true">■</span>
                  </button>
                }
              >
                <button
                  type="button"
                  class="ym-send"
                  onClick={sendMessage}
                  disabled={systemRoleEditing()}
                >
                  Send message
                  <span aria-hidden="true">↑</span>
                </button>
              </Show>
            </div>
          </div>

          <div class="ym-composer-footer">
            <span id="ym-input-hint">
              Enter to send · Shift + Enter for a new line
            </span>

            <button
              type="button"
              class="ym-clear"
              onClick={clearChat}
              disabled={
                loading()
                || systemRoleEditing()
                || !hasConversation()
              }
            >
              <IconClear />
              Clear chat
            </button>
          </div>
        </div>
      </div>

      <p class="ym-disclaimer">
        AI can make mistakes. Double-check important information.
      </p>
    </section>
  )
}
