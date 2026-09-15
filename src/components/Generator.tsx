
import { Index, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { useThrottleFn } from 'solidjs-use'
import { generateSignature } from '@/utils/auth'
import IconClear from './icons/Clear'
import IconImage from './icons/Image'
import MessageItem from './MessageItem'
import SystemRoleSettings from './SystemRoleSettings'
import ErrorMessageItem from './ErrorMessageItem'
import type { ChatMessage, ErrorMessage } from '@/types'

type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export default function ChatPage() {
  let inputRef!: HTMLTextAreaElement
  let fileInputRef!: HTMLInputElement

  const [currentSystemRoleSettings, setCurrentSystemRoleSettings] = createSignal('')
  const [systemRoleEditing, setSystemRoleEditing] = createSignal(false)
  const [messageList, setMessageList] = createSignal<ChatMessage[]>([])
  const [currentError, setCurrentError] = createSignal<ErrorMessage | null>(null)
  const [currentAssistantMessage, setCurrentAssistantMessage] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [controller, setController] = createSignal<AbortController | null>(null)
  const [selectedImages, setSelectedImages] = createSignal<string[]>([])

  const smoothToBottom = useThrottleFn(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  }, 300, false, true)

  const persistState = () => {
    localStorage.setItem('messageList', JSON.stringify(messageList()))
    localStorage.setItem('systemRoleSettings', currentSystemRoleSettings())
  }

  const restoreState = () => {
    try {
      const storedMessages = localStorage.getItem('messageList')
      const storedSystemRole = localStorage.getItem('systemRoleSettings')

      if (storedMessages)
        setMessageList(JSON.parse(storedMessages))

      if (storedSystemRole)
        setCurrentSystemRoleSettings(storedSystemRole)
    } catch (err) {
      console.error(err)
    }
  }

  onMount(() => {
    restoreState()
    window.addEventListener('beforeunload', persistState)

    onCleanup(() => {
      window.removeEventListener('beforeunload', persistState)
    })
  })

  const resetTextareaHeight = () => {
    if (!inputRef) return
    inputRef.style.height = 'auto'
  }

  const autosizeTextarea = () => {
    if (!inputRef) return
    inputRef.style.height = 'auto'
    inputRef.style.height = `${inputRef.scrollHeight}px`
  }

  const focusInput = () => {
    inputRef?.focus()
  }

  const clearSelectedImages = () => {
    setSelectedImages([])
  }

  const openFilePicker = () => {
    fileInputRef?.click()
  }

  const removeImage = (index: number) => {
    setSelectedImages(prev => prev.filter((_, i) => i !== index))
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
    if (!message) return ''

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
      setMessageList(prev => [
        ...prev,
        {
          role: 'assistant',
          content: assistantText,
        },
      ])
      setCurrentAssistantMessage('')
    }

    setLoading(false)
    setController(null)
    focusInput()
  }

  const streamAssistantResponse = async (response: Response) => {
    const data = response.body
    if (!data)
      throw new Error('No data')

    const reader = data.getReader()
    const decoder = new TextDecoder('utf-8')
    let done = false

    while (!done) {
      const { value, done: readerDone } = await reader.read()

      if (value) {
        const chunk = decoder.decode(value)

        if (!(chunk === '\n' && currentAssistantMessage().endsWith('\n'))) {
          if (chunk)
            setCurrentAssistantMessage(prev => prev + chunk)
        }

        smoothToBottom()
      }

      done = readerDone
    }
  }

  const requestWithLatestMessage = async () => {
    setLoading(true)
    setCurrentAssistantMessage('')
    setCurrentError(null)

    const storagePassword = localStorage.getItem('pass')

    try {
      const abortController = new AbortController()
      setController(abortController)

      const requestMessages = buildRequestMessages()
      const timestamp = Date.now()
      const lastMessage = requestMessages[requestMessages.length - 1]
      const lastMessageContent = extractSignatureMessage(lastMessage)

      const response = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          messages: requestMessages,
          time: timestamp,
          pass: storagePassword,
          sign: await generateSignature({
            t: timestamp,
            m: lastMessageContent,
          }),
        }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const error = await response.json()
        console.error(error.error)
        setCurrentError(error.error)
        throw new Error('Request failed')
      }

      await streamAssistantResponse(response)
      archiveCurrentMessage()
    } catch (error) {
      console.error(error)
      setLoading(false)
      setController(null)
    }
  }

  const sendMessage = async () => {
    const text = inputRef.value.trim()
    const images = selectedImages()

    if (!text && images.length === 0)
      return

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    if (window?.umami) umami.trackEvent('chat_generate')

    const userMessage = buildUserMessage(text, images)

    setMessageList(prev => [...prev, userMessage])
    clearSelectedImages()

    inputRef.value = ''
    resetTextareaHeight()

    await requestWithLatestMessage()
  }

  const clearChat = () => {
    inputRef.value = ''
    resetTextareaHeight()
    setMessageList([])
    setCurrentAssistantMessage('')
    setCurrentError(null)
    setSelectedImages([])
    setLoading(false)
    setController(null)
  }

  const stopStreamFetch = () => {
    const currentController = controller()
    if (!currentController) return

    currentController.abort()
    archiveCurrentMessage()
  }

  const retryLastFetch = () => {
    const messages = messageList()
    if (messages.length === 0)
      return

    const lastMessage = messages[messages.length - 1]

    if (lastMessage.role === 'assistant')
      setMessageList(messages.slice(0, -1))

    requestWithLatestMessage()
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.isComposing || e.shiftKey)
      return

    if (e.key === 'Enter') {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleFileUpload = (e: Event) => {
    const files = (e.target as HTMLInputElement).files
    if (!files?.length)
      return

    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/'))
        return

      const reader = new FileReader()
      reader.onload = (event) => {
        const result = event.target?.result
        if (!result) return

        setSelectedImages(prev => [...prev, result as string])
        smoothToBottom()
      }
      reader.readAsDataURL(file)
    })

    fileInputRef.value = ''
  }

  const renderSelectedImages = () => (
    <Show when={selectedImages().length > 0}>
      <div
        class="selected-images-container"
        style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;"
      >
        <Index each={selectedImages()}>
          {(imageUrl, index) => (
            <div
              class="image-preview"
              style="position: relative; width: 100px; height: 100px;"
            >
              <img
                src={imageUrl()}
                alt={`Selected image ${index() + 1}`}
                style="width: 100%; height: 100%; object-fit: cover; border-radius: 4px;"
              />
              <button
                type="button"
                class="remove-image"
                style="position: absolute; top: -8px; right: -8px; background: rgba(0,0,0,0.6); color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; border: none;"
                onClick={() => removeImage(index())}
                aria-label={`Remove image ${index() + 1}`}
                title="Remove image"
              >
                ×
              </button>
            </div>
          )}
        </Index>
      </div>
    </Show>
  )

  const renderComposer = () => (
    <div class="gen-text-wrapper" class:op-50={systemRoleEditing()}>
      <textarea
        ref={inputRef}
        disabled={systemRoleEditing()}
        onKeyDown={handleKeydown}
        placeholder="Enter something... (or upload an image)"
        autocomplete="off"
        autofocus
        onInput={autosizeTextarea}
        rows="1"
        class="gen-textarea"
      />

      <button
        type="button"
        title="Upload Image"
        onClick={openFilePicker}
        disabled={systemRoleEditing()}
        gen-slate-btn
      >
        <IconImage />
      </button>

      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        multiple
        style="display: none;"
        onChange={handleFileUpload}
      />

      <button
        type="button"
        onClick={sendMessage}
        disabled={systemRoleEditing()}
        gen-slate-btn
      >
        Send
      </button>

      <button
        type="button"
        title="Clear"
        onClick={clearChat}
        disabled={systemRoleEditing()}
        gen-slate-btn
      >
        <IconClear />
      </button>
    </div>
  )

  return (
    <div my-6>
      <SystemRoleSettings
        canEdit={() => messageList().length === 0}
        systemRoleEditing={systemRoleEditing}
        setSystemRoleEditing={setSystemRoleEditing}
        currentSystemRoleSettings={currentSystemRoleSettings}
        setCurrentSystemRoleSettings={setCurrentSystemRoleSettings}
      />

      <Index each={messageList()}>
        {(message, index) => (
          <MessageItem
            role={message().role}
            message={message().content}
            showRetry={() => message().role === 'assistant' && index() === messageList().length - 1}
            onRetry={retryLastFetch}
          />
        )}
      </Index>

      {currentAssistantMessage() && (
        <MessageItem
          role="assistant"
          message={currentAssistantMessage}
        />
      )}

      {currentError() && (
        <ErrorMessageItem
          data={currentError()!}
          onRetry={retryLastFetch}
        />
      )}

      <Show
        when={!loading()}
        fallback={() => (
          <div class="gen-cb-wrapper">
            <span>AI is thinking...</span>
            <div class="gen-cb-stop" onClick={stopStreamFetch}>Stop</div>
          </div>
        )}
      >
        {renderSelectedImages()}
        {renderComposer()}
      </Show>
    </div>
  )
}