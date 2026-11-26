import { waitFor } from './webdriver-local.mjs'

const chat = '[data-testid="workbench-chat"]'
const newChat = `${chat} [data-testid="workbench-new-chat"]`
const sessionRow = `${chat} .cf-thread.is-active`
const draft = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
const send = `${chat} .cf-send:not(.is-stop)`
const stop = `${chat} .cf-send.is-stop`
const modelChip = `${chat} .model-pick button[aria-haspopup="menu"]`
const modelGroup = `${chat} .cf-mp__group`
const modelOption = '.model-pick__item[role="menuitemradio"]'
const userMessage = `${chat} [data-role="user"]`
const assistantMessage = `${chat} [data-role="assistant"]`
const turnStatus = `${chat} [data-testid="workbench-turn-status"]`
const completed = `${turnStatus}[data-status="completed"]`
const aborted = `${turnStatus}[data-status="aborted"]`
const stoppedLabels = ['Reply stopped', '回复已停止']

const firstText = 'Workbench E2E first turn'
const secondText = 'Workbench E2E stop turn'
const firstDelta = 'A first SSE fragment.'
const nextDelta = ' A second SSE fragment.'
const fullReply = firstDelta + nextDelta
const stoppedReply = 'An intentionally partial reply.'
const firstUser = { role: 'user', content: firstText }
const secondUser = { role: 'user', content: secondText }
const firstAssistant = { role: 'assistant', content: fullReply }

async function chooseModel(browser, element, providerName, modelId, signal) {
  await browser.click(await element(modelChip, 'chat model chooser'))
  const choice = await waitFor(() => browser.execute(`
    const [group, option, provider, model] = arguments;
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    for (const section of document.querySelectorAll(group)) {
      if (section.querySelector('.cf-mp__ghead')?.textContent.trim() !== provider) continue;
      for (const button of section.querySelectorAll(option)) {
        if (visible(button) && !button.disabled && button.textContent.trim() === model) return button;
      }
    }
    return null;
  `, modelGroup, modelOption, providerName, modelId), 'enabled model under the selected provider', { signal })
  await browser.click(choice)
  await element(modelChip, 'selected chat model', [modelId])
}

async function sendText(browser, element, text) {
  const input = await element(draft, 'desktop chat composer')
  await browser.click(input)
  await browser.keys(input, text)
  await browser.click(await element(send, 'desktop chat Send button'))
}

// Return only predicates; transcript text and session data stay in the page. Inspect the
// conversation rows, never the session title, composer, or another copy outside the thread.
function waitForThread(browser, signal, description, { users, replies, streaming }) {
  return waitFor(() => browser.execute(`
    const [userRow, assistantRow, stopButton, sendButton, users, replies, streaming] = arguments;
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    const rows = selector => Array.from(document.querySelectorAll(selector)).filter(visible);
    const text = (row, expected) => row && [row, ...row.querySelectorAll('*')]
      .some(node => visible(node) && node.textContent.trim() === expected);
    const orderedText = (selector, expected) => {
      const matches = rows(selector);
      return matches.length === expected.length && expected.every((item, i) => text(matches[i], item));
    };
    const running = rows(assistantRow + '[data-streaming="true"]');
    const stop = rows(stopButton);
    return orderedText(userRow, users) && orderedText(assistantRow, replies) &&
      (streaming ? stop.length === 1 && !stop[0].matches(':disabled') && running.length === 1 && text(running[0], replies.at(-1)) :
        !running.length && !stop.length && rows(sendButton).length === 1);
  `, userMessage, assistantMessage, stop, send, users, replies, streaming), description, { signal })
}

async function reopenChat(browser, element) {
  await browser.refresh() // The old document and its browser WebSocket both go away.
  await element(chat, 'chat view after refreshing')
  await element(sessionRow, 'existing conversation selected again after refreshing', [firstText], '.cf-thread__title')
}

export async function verifyChat({ browser, element, mock, providerName, modelId, signal, setStage }) {
  const thread = (description, users, replies, streaming) =>
    waitForThread(browser, signal, description, { users, replies, streaming })

  setStage('open chat, create a conversation and select the model')
  await element(chat, 'open chats after leaving model settings')
  await browser.click(await element(newChat, 'start a new conversation'))
  await chooseModel(browser, element, providerName, modelId, signal)
  mock.assertRequestCount(0)

  setStage('send first chat turn and observe active SSE text')
  await sendText(browser, element, firstText)
  const first = await mock.expectRequest(1, { messages: [firstUser], signal })
  first.delta(firstDelta)
  await thread('first SSE fragment in active desktop message', [firstText], [firstDelta], true)
  first.assertOpen()

  setStage('refresh active chat and resume the original upstream response')
  await reopenChat(browser, element)
  await thread('active partial reply restored after refresh', [firstText], [firstDelta], true)
  mock.assertRequestCount(1)
  first.assertOpen()
  first.delta(nextDelta)
  // Require both fragments with Stop still visible before sending any terminal SSE event.
  await thread('new SSE fragment appended after refresh while still active', [firstText], [fullReply], true)
  mock.assertRequestCount(1)
  first.finish()
  await element(completed, 'visible completed turn status', ['Reply complete', '回复已完成'])
  await thread('completed first reply in the desktop conversation', [firstText], [fullReply], false)

  setStage('send second chat turn and stop the upstream stream from the UI')
  await sendText(browser, element, secondText)
  const second = await mock.expectRequest(2, { messages: [firstUser, firstAssistant, secondUser], signal })
  second.delta(stoppedReply)
  await thread('second reply visibly streaming before Stop', [firstText, secondText], [fullReply, stoppedReply], true)
  second.assertOpen()
  await browser.click(await element(stop, 'desktop chat Stop button'))
  await second.waitForAbort({ signal }) // The fixture never sends EOF or completion for this response.
  await element(aborted, 'visible aborted turn status', stoppedLabels)
  await thread('aborted reply retained in the desktop conversation', [firstText, secondText], [fullReply, stoppedReply], false)
  mock.assertRequestCount(2)

  setStage('refresh stopped turn and verify its saved transcript and status')
  await reopenChat(browser, element)
  await element(aborted, 'persisted aborted turn status after refresh', stoppedLabels)
  await thread('saved messages after refreshing the stopped turn', [firstText, secondText], [fullReply, stoppedReply], false)
  mock.assertRequestCount(2)
}
