import { Index, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { useThrottleFn } from 'solidjs-use'
import { generateSignature } from '@/utils/auth'
import IconClear from './icons/Clear'
import IconImage from './icons/Image'
import MessageItem from './MessageItem'
import SystemRoleSettings from './SystemRoleSettings'
import ErrorMessageItem from './ErrorMessageItem'
import type { ChatMessage, ErrorMessage } from '@/types'

export default () => {
  let inputRef: HTMLTextAreaElement
  let fileInputRef: HTMLInputElement
  const [currentSystemRoleSettings, setCurrentSystemRoleSettings] = createSignal('')
  const [systemRoleEditing, setSystemRoleEditing] = createSignal(false)
  const [messageList, setMessageList] = createSignal<ChatMessage[]>([])
  const [currentError, setCurrentError] = createSignal<ErrorMessage>()
  const [currentAssistantMessage, setCurrentAssistantMessage] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [controller, setController] = createSignal<AbortController>(null)
  const [selectedImages, setSelectedImages] = createSignal<string[]>([])

  onMount(() => {
    try {
      if (localStorage.getItem('messageList'))
        setMessageList(JSON.parse(localStorage.getItem('messageList')))

      if (localStorage.getItem('systemRoleSettings'))
        setCurrentSystemRoleSettings(localStorage.getItem('systemRoleSettings'))
    } catch (err) {
      console.error(err)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    onCleanup(() => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    })
  })

  const handleBeforeUnload = () => {
    localStorage.setItem('messageList', JSON.stringify(messageList()))
    localStorage.setItem('systemRoleSettings', currentSystemRoleSettings())
  }

  const handleButtonClick = async() => {
    const inputValue = inputRef.value
    if (!inputValue && selectedImages().length === 0)
      return

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    if (window?.umami) umami.trackEvent('chat_generate')
    inputRef.value = ''
    
    // Create the user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: selectedImages().length > 0 
        ? [
            { type: 'text', text: inputValue || 'Analyze this image' },
            ...selectedImages().map(image => ({ type: 'image_url', image_url: { url: image } }))
          ]
        : inputValue,
    }
    
    setMessageList([...messageList(), userMessage])
    setSelectedImages([]) // Clear selected images after sending
    requestWithLatestMessage()
  }

  const smoothToBottom = useThrottleFn(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  }, 300, false, true)

  const requestWithLatestMessage = async() => {
    setLoading(true)
    setCurrentAssistantMessage('')
    setCurrentError(null)
    const storagePassword = localStorage.getItem('pass')
    try {
      const controller = new AbortController()
      setController(controller)
      const requestMessageList = [...messageList()]
      if (currentSystemRoleSettings()) {
        requestMessageList.unshift({
          role: 'system',
          content: currentSystemRoleSettings(),
        })
      }
      const timestamp = Date.now()
      const lastMessage = requestMessageList[requestMessageList.length - 1];
      // For signature generation, use a text representation of the message
      let lastMessageContent = '';
      
      if (typeof lastMessage.content === 'string') {
        lastMessageContent = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        // Find the text part of the message for signature
        const textPart = lastMessage.content.find(item => item.type === 'text');
        if (textPart && 'text' in textPart) {
          lastMessageContent = textPart.text;
        }
      }
      
      const response = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          messages: requestMessageList,
          time: timestamp,
          pass: storagePassword,
          sign: await generateSignature({
            t: timestamp,
            m: lastMessageContent,
          }),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = await response.json()
        console.error(error.error)
        setCurrentError(error.error)
        throw new Error('Request failed')
      }
      const data = response.body
      if (!data)
        throw new Error('No data')

      const reader = data.getReader()
      const decoder = new TextDecoder('utf-8')
      let done = false

      while (!done) {
        const { value, done: readerDone } = await reader.read()
        if (value) {
          const char = decoder.decode(value)
          if (char === '\n' && currentAssistantMessage().endsWith('\n'))
            continue

          if (char)
            setCurrentAssistantMessage(currentAssistantMessage() + char)

          smoothToBottom()
        }
        done = readerDone
      }
    } catch (e) {
      console.error(e)
      setLoading(false)
      setController(null)
      return
    }
    archiveCurrentMessage()
  }

  const archiveCurrentMessage = () => {
    if (currentAssistantMessage()) {
      setMessageList([
        ...messageList(),
        {
          role: 'assistant',
          content: currentAssistantMessage(),
        },
      ])
      setCurrentAssistantMessage('')
      setLoading(false)
      setController(null)
      inputRef.focus()
    }
  }

  const clear = () => {
    inputRef.value = ''
    inputRef.style.height = 'auto'
    setMessageList([])
    setCurrentAssistantMessage('')
    setCurrentError(null)
    setSelectedImages([])
  }

  const stopStreamFetch = () => {
    if (controller()) {
      controller().abort()
      archiveCurrentMessage()
    }
  }

  const retryLastFetch = () => {
    if (messageList().length > 0) {
      const lastMessage = messageList()[messageList().length - 1]
      if (lastMessage.role === 'assistant')
        setMessageList(messageList().slice(0, -1))

      requestWithLatestMessage()
    }
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.isComposing || e.shiftKey)
      return

    if (e.keyCode === 13) {
      e.preventDefault()
      handleButtonClick()
    }
  }

  const handleFileUpload = (e: Event) => {
    const files = (e.target as HTMLInputElement).files
    if (!files || files.length === 0) return

    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return

      const reader = new FileReader()
      reader.onload = (event) => {
        if (event.target?.result) {
          setSelectedImages([...selectedImages(), event.target.result as string])
          smoothToBottom()
        }
      }
      reader.readAsDataURL(file)
    })
    
    // Clear the input so the same file can be uploaded again if needed
    fileInputRef.value = ''
  }
  
  const handleImageClick = () => {
    fileInputRef.click()
  }
  
  const removeImage = (index: number) => {
    const images = [...selectedImages()]
    images.splice(index, 1)
    setSelectedImages(images)
  }

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
            showRetry={() => (message().role === 'assistant' && index === messageList().length - 1)}
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
      { currentError() && <ErrorMessageItem data={currentError()} onRetry={retryLastFetch} /> }
      <Show
        when={!loading()}
        fallback={() => (
          <div class="gen-cb-wrapper">
            <span>AI is thinking...</span>
            <div class="gen-cb-stop" onClick={stopStreamFetch}>Stop</div>
          </div>
        )}
      >
        {/* Display selected images */}
        <Show when={selectedImages().length > 0}>
          <div class="selected-images-container" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;">
            <Index each={selectedImages()}>
              {(imageUrl, index) => (
                <div class="image-preview" style="position: relative; width: 100px; height: 100px;">
                  <img 
                    src={imageUrl()} 
                    style="width: 100%; height: 100%; object-fit: cover; border-radius: 4px;"
                  />
                  <div 
                    class="remove-image" 
                    style="position: absolute; top: -8px; right: -8px; background: rgba(0,0,0,0.6); color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer;"
                    onClick={() => removeImage(index)}
                  >×</div>
                </div>
              )}
            </Index>
          </div>
        </Show>
        
        <div class="gen-text-wrapper" class:op-50={systemRoleEditing()}>
          <textarea
            ref={inputRef!}
            disabled={systemRoleEditing()}
            onKeyDown={handleKeydown}
            placeholder="Enter something... (or upload an image)"
            autocomplete="off"
            autofocus
            onInput={() => {
              inputRef.style.height = 'auto'
              inputRef.style.height = `${inputRef.scrollHeight}px`
            }}
            rows="1"
            class="gen-textarea"
          />
          <button title="Upload Image" onClick={handleImageClick} disabled={systemRoleEditing()} gen-slate-btn>
            <IconImage />
          </button>
          <input 
            type="file" 
            ref={fileInputRef!} 
            accept="image/*" 
            multiple 
            style="display: none;" 
            onChange={handleFileUpload} 
          />
          <button onClick={handleButtonClick} disabled={systemRoleEditing()} gen-slate-btn>
            Send
          </button>
          <button title="Clear" onClick={clear} disabled={systemRoleEditing()} gen-slate-btn>
            <IconClear />
          </button>
        </div>
      </Show>
    </div>
  )
}
