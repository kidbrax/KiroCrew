/**
 * Chat sidebar — the folder pin.
 *
 * A pinned folder's sessions (subfolders included) stay listed while the status
 * chips, the tag chips or the folder checkboxes narrow the list. Text search is
 * NOT stepped over: a query names what the person wants to see, a chip only
 * trims the view. The pin lives on the folder (`PATCH /api/chat/folders/:id
 * {pinned}`), the rows under it are not pinned individually, and the controls
 * that the pin overrides read inert rather than offering a tick that would
 * change nothing on screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { createTestStore } from './helpers'
import { ThemeProvider } from '../hooks/useTheme'

// Render framer-motion elements as plain DOM (happy-dom can't run projection).
vi.mock('framer-motion', async () => {
  const React = await import('react')
  const FRAMER_PROPS = new Set([
    'layout', 'layoutId', 'layoutScroll', 'initial', 'animate', 'exit',
    'transition', 'variants', 'whileHover', 'whileTap', 'whileInView',
    'drag', 'dragConstraints', 'dragElastic', 'onAnimationComplete',
  ])
  const make = (tag: string) =>
    React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      const clean: Record<string, unknown> = {}
      for (const k of Object.keys(props)) {
        if (k === 'children') continue
        if (k === 'layoutId') { clean['data-layout-id'] = props[k]; continue }
        if (FRAMER_PROPS.has(k)) continue
        clean[k] = props[k]
      }
      return React.createElement(tag, { ...clean, ref }, props.children as React.ReactNode)
    })
  const motion = new Proxy({}, { get: (_t, tag: string) => make(tag) })
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    LayoutGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('../components/ProjectPicker', () => ({ default: () => null }))
vi.mock('../pages/chat/ChatSettings', () => ({
  loadChatConfig: () => ({ tagColumnsEnabled: false, confirmCloseSession: false }),
  saveChatConfig: vi.fn(),
}))

const mocks = vi.hoisted(() => ({ updateChatFolder: vi.fn() }))

vi.mock('../api/client', () => ({
  SEARCH_MIN_CHARS: 2,
  api: new Proxy(mocks as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop]
      if (prop === 'chatTags') return vi.fn().mockResolvedValue([
        { id: 't1', name: 'Alpha', color: '#ff0000', order: 0 },
      ])
      return vi.fn().mockResolvedValue([])
    },
  }),
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
})

import ChatSidebar from '../pages/ChatSidebar'
import type { RootState } from '../store'
import type { ChatFolder, ChatSlot } from '../types'

const RUNNING_ONLY_LS_KEY = 'mc-session-running-only'
const TAG_FILTER_LS_KEY = 'mc-session-tag-filter'
const HIDDEN_FOLDERS_LS_KEY = 'mc-flat-hidden-folders'

/** Two folders of one idle, untagged session each; `pinnedF` is pinned, `plainF` is not. */
const FOLDERS: ChatFolder[] = [
  { id: 'pinnedF', name: 'oncall', collapsed: false, order: 0, pinned: true },
  { id: 'plainF', name: 'research', collapsed: false, order: 1 },
]
const SLOTS = [
  { key: 'chat-1-100', title: 'oncall session', running: false, messages: 2, folder_id: 'pinnedF' },
  { key: 'chat-2-200', title: 'research session', running: false, messages: 2, folder_id: 'plainF' },
] as unknown as ChatSlot[]

function renderSidebar(slots: ChatSlot[] = SLOTS, folders: ChatFolder[] = FOLDERS) {
  const defaults = createTestStore().getState()
  const store = createTestStore({
    dashboard: {
      ...defaults.dashboard,
      status: {}, connected: true, slots, approvalMode: 'normal',
      channelTrusted: false, refreshTrigger: 0, unreadSlots: [], updateProgress: null,
      slotsLoaded: true,
      subagentRunning: {}, subagentDetails: {}, subagentText: {},
      sessionDefaultColor: null, sessionColorsMode: 'tint', sessionColorsPalette: 'horizon', sessionColorsIntensity: 'clear',
    } as unknown as RootState['dashboard'],
    chat: {
      ...defaults.chat,
      activeSlot: null, slotStatusDetail: {}, revealRequest: null, revealNonce: 0,
    } as unknown as RootState['chat'],
  })
  // staleTime keeps the seeded folder list authoritative: the blanket api mock
  // resolves every call to [], so an on-mount refetch would wipe the folders.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false }, mutations: { retry: false } } })
  qc.setQueryData(['chat-folders'], folders)
  return render(
    <QueryClientProvider client={qc}>
      <Provider store={store}>
        <ThemeProvider>
          <MemoryRouter>
            <ChatSidebar
              slots={slots} activeSlot={null} unreadSlots={[]}
              history={[]} historyHasMore={false} defaultAgent="" installedAgents={[]}
            />
          </MemoryRouter>
        </ThemeProvider>
      </Provider>
    </QueryClientProvider>,
  )
}

/** Open a folder header's ⋯ menu. Keyboard activation is the path happy-dom
 *  handles, and the menu lives only for the current tick, so callers drive the
 *  item they want synchronously (see ChatSidebarW3Coverage for the full note). */
function openFolderMenu(folderId: string) {
  fireEvent.keyDown(screen.getByTestId(`folder-menu-${folderId}`), { key: 'Enter' })
  expect(screen.getByTestId(`folder-settings-${folderId}`)).toBeTruthy()
}

beforeEach(() => {
  localStorage.clear()
  mocks.updateChatFolder.mockReset().mockResolvedValue({})
})
afterEach(() => vi.clearAllMocks())

describe('a pinned folder steps over the chips and the folder checkboxes', () => {
  it('status chip: an idle session in a pinned folder stays under Running, one in a plain folder goes', async () => {
    localStorage.setItem(RUNNING_ONLY_LS_KEY, '1')
    const { queryByText } = renderSidebar()
    await waitFor(() => expect(queryByText('oncall session')).not.toBeNull())
    expect(queryByText('research session')).toBeNull()
  })

  it('tag chip: an untagged session in a pinned folder stays, one in a plain folder goes', async () => {
    localStorage.setItem(TAG_FILTER_LS_KEY, JSON.stringify(['t1']))
    const { queryByText } = renderSidebar()
    await waitFor(() => expect(queryByText('oncall session')).not.toBeNull())
    // The vocabulary resolves asynchronously; the plain row goes once it has.
    await waitFor(() => expect(queryByText('research session')).toBeNull())
  })

  it('folder checkbox: unchecking a pinned folder hides nothing, in the tree and in the flat lane', async () => {
    localStorage.setItem(HIDDEN_FOLDERS_LS_KEY, JSON.stringify(['pinnedF', 'plainF']))
    const tree = renderSidebar()
    await waitFor(() => expect(tree.queryByText('oncall session')).not.toBeNull())
    expect(tree.queryByText('research session')).toBeNull()
    tree.unmount()
    localStorage.setItem('mc-sidebar-flat-view', '1')
    const flat = renderSidebar()
    await waitFor(() => expect(flat.queryByText('oncall session')).not.toBeNull())
    expect(flat.queryByText('research session')).toBeNull()
  })

  it('the pin covers the whole subtree: a session in a subfolder of a pinned folder stays', async () => {
    localStorage.setItem(RUNNING_ONLY_LS_KEY, '1')
    const folders: ChatFolder[] = [
      ...FOLDERS,
      { id: 'childF', name: 'pages', collapsed: false, order: 0, parent_id: 'pinnedF' },
      { id: 'plainChildF', name: 'notes', collapsed: false, order: 0, parent_id: 'plainF' },
    ]
    const slots = [
      { key: 'chat-3-300', title: 'oncall pages session', running: false, messages: 2, folder_id: 'childF' },
      { key: 'chat-4-400', title: 'research notes session', running: false, messages: 2, folder_id: 'plainChildF' },
    ] as unknown as ChatSlot[]
    const { queryByText } = renderSidebar(slots, folders)
    await waitFor(() => expect(queryByText('oncall pages session')).not.toBeNull())
    expect(queryByText('research notes session')).toBeNull()
  })

  it('an unchecked ancestor does not take a pinned subfolder with it, in the tree and in the flat lane', async () => {
    // The finding both local review lanes raised: `parent` is unchecked, its
    // child `oncallF` is pinned. Dropping the parent's block would drop the
    // pinned child's sessions in the tree and the board while the flat lane
    // still listed them. The pin steps over the hide on the whole chain, so the
    // parent's block stays and its own sessions stay with it, in every lane.
    const folders: ChatFolder[] = [
      { id: 'parentF', name: 'ops', collapsed: false, order: 0 },
      { id: 'pinnedF', name: 'oncall', collapsed: false, order: 0, parent_id: 'parentF', pinned: true },
      { id: 'plainF', name: 'research', collapsed: false, order: 1 },
    ]
    const slots = [
      ...SLOTS,
      { key: 'chat-6-600', title: 'ops rota', running: false, messages: 2, folder_id: 'parentF' },
    ] as unknown as ChatSlot[]
    localStorage.setItem(HIDDEN_FOLDERS_LS_KEY, JSON.stringify(['parentF', 'plainF']))
    const tree = renderSidebar(slots, folders)
    await waitFor(() => expect(tree.queryByText('oncall session')).not.toBeNull())
    expect(tree.queryByText('ops rota')).not.toBeNull()
    expect(tree.queryByText('research session')).toBeNull()
    tree.unmount()
    localStorage.setItem('mc-sidebar-flat-view', '1')
    const flat = renderSidebar(slots, folders)
    await waitFor(() => expect(flat.queryByText('oncall session')).not.toBeNull())
    expect(flat.queryByText('ops rota')).not.toBeNull()
    expect(flat.queryByText('research session')).toBeNull()
  })

  it('the chips still narrow an ancestor of a pinned folder: the pin covers the subtree, not the chain', async () => {
    const folders: ChatFolder[] = [
      { id: 'parentF', name: 'ops', collapsed: false, order: 0 },
      { id: 'pinnedF', name: 'oncall', collapsed: false, order: 0, parent_id: 'parentF', pinned: true },
    ]
    const slots = [
      { key: 'chat-1-100', title: 'oncall session', running: false, messages: 2, folder_id: 'pinnedF' },
      { key: 'chat-6-600', title: 'ops rota', running: false, messages: 2, folder_id: 'parentF' },
    ] as unknown as ChatSlot[]
    localStorage.setItem(RUNNING_ONLY_LS_KEY, '1')
    const { queryByText } = renderSidebar(slots, folders)
    await waitFor(() => expect(queryByText('oncall session')).not.toBeNull())
    expect(queryByText('ops rota')).toBeNull()
  })

  it('text search still narrows a pinned folder: a non-matching session goes', async () => {
    const slots = [
      ...SLOTS,
      { key: 'chat-5-500', title: 'oncall runbook', running: false, messages: 2, folder_id: 'pinnedF' },
    ] as unknown as ChatSlot[]
    const utils = renderSidebar(slots)
    await waitFor(() => expect(utils.queryByText('oncall session')).not.toBeNull())
    fireEvent.change(utils.getByPlaceholderText('Search sessions…'), { target: { value: 'runbook' } })
    await waitFor(() => expect(utils.queryByText('oncall session')).toBeNull())
    expect(utils.queryByText('oncall runbook')).not.toBeNull()
  })

  it('the chip still shows as narrowing: other rows are narrowed, the list is not "unfiltered"', async () => {
    localStorage.setItem(RUNNING_ONLY_LS_KEY, '1')
    const utils = renderSidebar()
    await waitFor(() => expect(utils.queryByText('oncall session')).not.toBeNull())
    // The plain folder's session is gone, so the list IS narrowed; the pinned
    // row surviving must not read as "nothing is filtered".
    expect(utils.queryByText('research session')).toBeNull()
  })
})

describe('the pin on the folder, not on its rows', () => {
  it('the pinned folder header carries the pin glyph; a plain one does not', async () => {
    const utils = renderSidebar()
    await waitFor(() => expect(utils.queryByText('oncall session')).not.toBeNull())
    expect(utils.getByTestId('folder-pinned-pinnedF')).toBeTruthy()
    expect(utils.queryByTestId('folder-pinned-plainF')).toBeNull()
  })

  it('a session in a pinned folder is not itself pinned: no pinned-session marker on its row', async () => {
    const utils = renderSidebar()
    await waitFor(() => expect(utils.queryByText('oncall session')).not.toBeNull())
    const row = utils.getByText('oncall session').closest('[data-session-row]')
    expect(row).not.toBeNull()
    // The session pin renders its glyph on the row, titled "Pinned"; a folder
    // pin leaves the row exactly as an unpinned session's.
    expect(row!.querySelector('[title="Pinned"]')).toBeNull()
    expect(utils.queryByTestId('pinned-session-divider')).toBeNull()
  })
})

describe('the folder menu', () => {
  it('offers Pin folder on a plain folder and PATCHes pinned: true', async () => {
    renderSidebar()
    openFolderMenu('plainF')
    expect(screen.getByTestId('folder-pin-plainF').textContent).toContain('Pin folder')
    fireEvent.click(screen.getByTestId('folder-pin-plainF'))
    await waitFor(() => expect(mocks.updateChatFolder).toHaveBeenCalledWith('plainF', { pinned: true }))
  })

  it('offers Unpin folder on a pinned folder and PATCHes pinned: false', async () => {
    renderSidebar()
    openFolderMenu('pinnedF')
    expect(screen.getByTestId('folder-pin-pinnedF').textContent).toContain('Unpin folder')
    fireEvent.click(screen.getByTestId('folder-pin-pinnedF'))
    await waitFor(() => expect(mocks.updateChatFolder).toHaveBeenCalledWith('pinnedF', { pinned: false }))
  })

  it('withholds Hide folder under a pin, and keeps it on a plain folder', async () => {
    const first = renderSidebar()
    openFolderMenu('pinnedF')
    expect(screen.queryByTestId('folder-visibility-pinnedF')).toBeNull()
    first.unmount()
    renderSidebar()
    openFolderMenu('plainF')
    expect(screen.getByTestId('folder-visibility-plainF')).toBeTruthy()
  })

  it('pinning a subfolder lifts the hide on its ancestors too', async () => {
    const folders: ChatFolder[] = [
      { id: 'parentF', name: 'ops', collapsed: false, order: 0 },
      { id: 'childF', name: 'pages', collapsed: false, order: 0, parent_id: 'parentF' },
    ]
    const slots = [
      { key: 'chat-7-700', title: 'pages session', running: false, messages: 2, folder_id: 'childF' },
    ] as unknown as ChatSlot[]
    // Only the PARENT is unchecked; the child's block goes with it.
    localStorage.setItem(HIDDEN_FOLDERS_LS_KEY, JSON.stringify(['parentF']))
    const utils = renderSidebar(slots, folders)
    expect(utils.queryByText('pages session')).toBeNull()
    // Peek the hidden parent open; the child block renders inside it.
    fireEvent.click(utils.getByTestId('hidden-reveal-root').querySelector('button')!)
    openFolderMenu('childF')
    fireEvent.click(screen.getByTestId('folder-pin-childF'))
    await waitFor(() => expect(mocks.updateChatFolder).toHaveBeenCalledWith('childF', { pinned: true }))
    expect(JSON.parse(localStorage.getItem(HIDDEN_FOLDERS_LS_KEY) ?? '[]')).toEqual([])
    await waitFor(() => expect(utils.queryByText('pages session')).not.toBeNull())
  })

  it('pinning a folder that was hidden lifts the hide, so the two never both hold', async () => {
    localStorage.setItem(HIDDEN_FOLDERS_LS_KEY, JSON.stringify(['plainF']))
    const utils = renderSidebar()
    expect(utils.queryByText('research session')).toBeNull()
    // A hidden folder's block is gone from the tree, header and all; the way to
    // its menu is the reveal row that peeks the hidden folders open in place.
    fireEvent.click(utils.getByTestId('hidden-reveal-root').querySelector('button')!)
    openFolderMenu('plainF')
    fireEvent.click(screen.getByTestId('folder-pin-plainF'))
    await waitFor(() => expect(mocks.updateChatFolder).toHaveBeenCalledWith('plainF', { pinned: true }))
    expect(JSON.parse(localStorage.getItem(HIDDEN_FOLDERS_LS_KEY) ?? '[]')).toEqual([])
    // The optimistic cache update already carries `pinned`, so the row is back.
    await waitFor(() => expect(utils.queryByText('research session')).not.toBeNull())
  })
})

describe('the filter menu folder row', () => {
  it('reads checked and inert for an ancestor of a pinned folder, and says why', async () => {
    const folders: ChatFolder[] = [
      { id: 'parentF', name: 'ops', collapsed: false, order: 0 },
      { id: 'pinnedF', name: 'oncall', collapsed: false, order: 0, parent_id: 'parentF', pinned: true },
    ]
    localStorage.setItem(HIDDEN_FOLDERS_LS_KEY, JSON.stringify(['parentF']))
    const utils = renderSidebar(SLOTS, folders)
    await waitFor(() => expect(utils.queryByText('oncall session')).not.toBeNull())
    fireEvent.keyDown(utils.getByLabelText('Sort and filter sessions'), { key: 'Enter' })
    const row = await screen.findByTestId('folder-filter-parentF')
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.getAttribute('data-disabled')).not.toBeNull()
    expect(row.getAttribute('title')).toBe('ops holds a pinned folder, so it stays listed')
    expect(row.getAttribute('data-folder-pinned')).toBeNull()
  })

  it('reads checked and inert for a pinned folder, and says why', async () => {
    localStorage.setItem(HIDDEN_FOLDERS_LS_KEY, JSON.stringify(['pinnedF']))
    const utils = renderSidebar()
    await waitFor(() => expect(utils.queryByText('oncall session')).not.toBeNull())
    fireEvent.keyDown(utils.getByLabelText('Sort and filter sessions'), { key: 'Enter' })
    const row = await screen.findByTestId('folder-filter-pinnedF')
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.getAttribute('data-disabled')).not.toBeNull()
    expect(row.getAttribute('title')).toBe('oncall is pinned: its sessions stay listed under every filter')
    const plain = screen.getByTestId('folder-filter-plainF')
    expect(plain.getAttribute('aria-checked')).toBe('true')
    expect(plain.getAttribute('data-disabled')).toBeNull()
  })
})
