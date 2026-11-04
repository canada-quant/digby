import Cocoa
import WebKit
import AVFoundation
import Speech

// ── Voice conversation mode (push-to-talk) ───────────────────────────────────
// Smallest shippable slice: native SFSpeechRecognizer turns a push-to-talk
// utterance into text, the text rides the ALREADY-LOADED web app (digby.example.com in
// the WKWebView — auth, modes, streaming, memory all reused), and the reply is
// spoken by clicking the web transcript's own "Read aloud" button (the web's
// proven voiceApi.tts → OpenAI TTS pipeline — no native TTS surface to build).
//
//   STT in   : SFSpeechRecognizer + AVAudioEngine (native, no getUserMedia —
//              the WKWebView mic path is why the web voice composer stays
//              disabled in this shell, ticket 00504a77).
//   LLM turn : JS bridge — native text-setter + input event on the composer
//              textarea, then a synthetic ⌘Enter keydown (the submit gesture
//              for BOTH composer variants — ChatComposerTextarea onKeyDown).
//   TTS out  : a reply watcher polls for the composer's Stop button to appear
//              (run started) then disappear (run finished), settles 1.5s, and
//              clicks the LAST "Read aloud" button — the newest assistant
//              message is read aloud by the web app itself.
//
// Wake-word is deliberately OUT of the slice: press-to-toggle PTT only.
// DOM-fragility is contained to three anchors documented above; every failure
// path degrades to a status message, never a crash.

enum VoiceState {
    case idle
    case recording
    case awaitingReply
}

final class VoiceController: NSObject {
    /// Status line shown in the Voice menu + window title suffix.
    private(set) var status: String = "Voice ready" {
        didSet { onStatusChange?(status) }
    }
    /// Menu/window hookup, set by the AppDelegate.
    var onStatusChange: ((String) -> Void)?
    /// "Speak Replies Automatically" — persisted; when OFF the reply watcher
    /// is skipped (PTT still transcribes + sends).
    var speakReplies: Bool {
        get { UserDefaults.standard.object(forKey: "voiceSpeakReplies") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "voiceSpeakReplies") }
    }

    private weak var webView: WKWebView?
    private var state: VoiceState = .idle

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    // LONG-UTTERANCE SEGMENTATION (ticket 9255c3f0): a single recognition task
    // degrades on long audio — the on-device session exhausts its internal
    // budget mid-utterance, delivers isFinal early with only the newest
    // seconds ("only sends the last few words, not the whole text"), and the
    // old code then REPLACED the transcript with that tail and killed the
    // session. Instead the utterance is SPLIT: text already heard is sealed
    // (sealedText) and the active task re-transcribes only ITS OWN audio;
    // every segmentSeconds — or the moment a task finalizes mid-utterance —
    // the segment is sealed and a fresh task takes over, primed with a small
    // ring of the most recent audio (~audioRingSeconds) so the boundary lands
    // between words. The tap feeds the live request AND the ring with every
    // buffer (no cursor gating — a gated tap went deaf between a
    // mid-utterance isFinal and the next rotation), and mergeSegment dedupes
    // only the ring's re-heard overlap, so no word is doubled, lost, or
    // truncated.
    private static let segmentSeconds: TimeInterval = 45
    private static let audioRingSeconds: TimeInterval = 1.5
    /// Finalization grace after stop before the best partial is used. Longer
    /// than the old 2.5s: finals around a seam can lag a beat longer.
    private static let finalizeGrace: TimeInterval = 4
    private var rotationTimer: Timer?
    /// Text heard BEFORE the current segment: authoritative, never
    /// re-submitted to a task. Set at rotation from fullTranscript.count —
    /// the sealed/live cursor is sealedText.count — and NEVER reset to 0 by a
    /// rotation (the old cursor reset discarded sealed text at every seam).
    private var sealedText = ""
    /// The CURRENT task's own deduped contribution — its cumulative partial
    /// minus the re-heard ring overlap. Replaced by every partial (a task's
    /// refinements update in place instead of appending duplicates).
    private var liveSegment = ""
    /// The tail of sealedText the ring re-hears (last ~10 words, captured at
    /// each rotation): the baseline every absorb dedupes against (review leg
    /// 2026-10-28). The fresh task's FIRST post-seam result re-transcribes
    /// the ring while liveSegment is still empty — mergeSegment("", …) could
    /// never dedupe there and duplicated the ring into the transcript. Empty
    /// for the first segment.
    private var ringTail = ""
    /// Everything the utterance has produced so far (sealed + live): the
    /// word-count status and the final send read this.
    private var fullTranscript: String {
        if sealedText.isEmpty { return liveSegment }
        // No separator when a seam just cleared the live segment — a
        // trailing space here compounded into doubled spaces in the final
        // text (review-leg pipeline test).
        return liveSegment.isEmpty ? sealedText : sealedText + " " + liveSegment
    }
    /// Most recent ~audioRingSeconds of captured audio, handed to each fresh
    /// task at a seam. Plain buffers under ARC (no manual retain/release);
    /// the tap (audio thread) writes, the main thread swaps — ringLock-guarded.
    private var audioRing: [AVAudioPCMBuffer] = []
    private var audioRingDuration: Double = 0
    private let ringLock = NSLock()
    /// Latched at stop: the utterance is terminal, a stale result arriving
    /// after stopRecording must no longer resurrect the transcript.
    private var stopping = false
    /// After endAudio we give the recognizer this long to produce isFinal
    /// before sending the best partial (silence at the end of an utterance
    /// can stall the final result for seconds).
    private var finalizeTimer: Timer?
    /// True once a stop was requested — a second PTT press cancels instead.
    private var stoppingForSend = false
    /// DICTATION (2026-10-20): the web composer's mic button toggles the same
    /// native recorder over the bridge ({type:'voice', event:'dictate'}), but
    /// the transcript is INSERTED into the focused composer and NOT sent — the
    /// user edits and sends it like typed text. Push-to-talk (⇧⌘Space) keeps
    /// its record → send → speak-the-reply loop.
    private var dictating = false

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    // MARK: - Public entry points (menu)

    /// Push-to-talk toggle: idle → record; recording → stop + send;
    /// awaitingReply → cancel the watcher and record again.
    @objc func togglePushToTalk() {
        switch state {
        case .idle:
            requestAuthorizations { [weak self] granted in
                guard let self = self else { return }
                if granted { self.startRecording() }
            }
        case .recording:
            stopRecording(send: true)
        case .awaitingReply:
            cancelAwaitingReply()
            requestAuthorizations { [weak self] granted in
                guard let self = self else { return }
                if granted { self.startRecording() }
            }
        }
    }

    /// Composer-mic toggle from the web app (dictation bridge). First call
    /// starts the native recorder; the second stops it and inserts the text.
    func toggleDictation() {
        switch state {
        case .idle:
            cancelAwaitingReply()
            requestAuthorizations { [weak self] granted in
                guard let self = self else { return }
                if granted {
                    self.dictating = true
                    self.startRecording()
                    self.postVoiceState("recording")
                } else {
                    self.postVoiceState("idle")
                }
            }
        case .recording:
            if dictating {
                postVoiceState("transcribing")
                stopRecording(send: false)
            } else {
                // A push-to-talk utterance is live: the mic tap ends it the
                // way ⇧⌘Space would (send), never as a silent cancel.
                stopRecording(send: true)
            }
        case .awaitingReply:
            cancelAwaitingReply()
            toggleDictation()
        }
    }

    /// Mirror the recorder's state onto the web mic button
    /// (use-voice-composer.ts listens for `digby:voice` on window).
    private func postVoiceState(_ voiceState: String) {
        let js = "window.dispatchEvent(new CustomEvent('digby:voice', { detail: { state: '\(voiceState)' } }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Permissions

    /// MIC FIRST, UNCONDITIONALLY (ticket 8b13ec2b). The shipped order
    /// requested Speech FIRST and only asked for the microphone after Speech
    /// came back .authorized — a sticky denied/restricted Speech TCC record
    /// aborted with an alert BEFORE AVCaptureDevice.requestAccess ever fired.
    /// macOS only lists an app under Privacy & Security → Microphone after
    /// the app itself asks (users cannot add it by hand — drag-drop is
    /// impossible by design), so on those Macs Digby never appeared in the
    /// list at all. Now the microphone request fires on EVERY first shortcut
    /// press regardless of Speech state, and Speech is requested only after
    /// the mic is granted.
    private func requestAuthorizations(completion: @escaping (Bool) -> Void) {
        requestMicPermission { [weak self] micGranted in
            guard let self = self else { return }
            guard micGranted else {
                self.status = "Microphone not authorized"
                self.permissionAlert(
                    "Microphone Needed",
                    "Digby uses the microphone for push-to-talk voice messages. macOS only lists an app under Privacy & Security → Microphone after the app asks — turn Digby on there, then press the shortcut again.",
                    pane: "Privacy_Microphone")
                completion(false)
                return
            }
            SFSpeechRecognizer.requestAuthorization { speechStatus in
                DispatchQueue.main.async {
                    guard speechStatus == .authorized else {
                        self.status = "Speech recognition not authorized"
                        self.permissionAlert(
                            "Speech Recognition Needed",
                            "Digby uses speech recognition to turn push-to-talk voice messages into text. Enable it in System Settings → Privacy & Security → Speech Recognition, then try again.",
                            pane: "Privacy_SpeechRecognition")
                        completion(false)
                        return
                    }
                    completion(true)
                }
            }
        }
    }

    /// Fire the macOS microphone TCC request — the ONLY thing that puts
    /// Digby into the Microphone list (8b13ec2b). macOS 14 deprecates
    /// AVCaptureDevice.requestAccess(for: .audio) in favor of
    /// AVAudioApplication.requestRecordPermission; the deployment target is
    /// macOS 12, so branch at runtime. Handler always runs on the main queue.
    private func requestMicPermission(_ handler: @escaping (Bool) -> Void) {
        if #available(macOS 14.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { handler(granted) }
            }
        } else {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { handler(granted) }
            }
        }
    }

    /// Denial alert. `pane` is the exact Privacy sub-pane to deep-link to —
    /// the bare `?Privacy` URL this used to open lands on the GENERIC
    /// Privacy & Security screen (the owner's report: "it opens the privacy
    /// settings, but it doesn't open into the microphone settings").
    private func permissionAlert(_ title: String, _ message: String, pane: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: "Open Settings")
        a.addButton(withTitle: "Not Now")
        if a.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
        }
    }

    // MARK: - Recording (STT in)

    private func startRecording() {
        // Double-PTT while the async permission prompt is still out must not
        // stack a second AVAudioEngine on top of a live one (review M1).
        guard state == .idle else { return }
        guard let recognizer = recognizer, recognizer.isAvailable else {
            status = "Speech recognizer unavailable"
            return
        }
        cancelFinalizeTimer()
        sealedText = ""
        liveSegment = ""
        ringTail = ""
        stoppingForSend = false
        stopping = false

        let engine = AVAudioEngine()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            // Prefer on-device: private + works offline. Falls back gracefully
            // when the locale lacks an on-device model (task still runs).
            req.requiresOnDeviceRecognition = true
        }

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            // EVERY buffer goes BOTH places (9255c3f0 rework): into the live
            // request (no cursor gating — a gated tap went deaf between a
            // mid-utterance isFinal and the next rotation) and into the
            // overlap ring the next segment re-hears at its seam. Plain
            // [AVAudioPCMBuffer] under ARC — no manual retain/release.
            self.ringLock.lock()
            self.audioRing.append(buffer)
            let dur = buffer.frameLength / buffer.format.sampleRate
            if dur.isFinite && dur > 0 { self.audioRingDuration += dur }
            // Trim by duration, subtracting each dropped buffer's seconds —
            // otherwise the trim never terminates and the ring collapses to
            // one buffer. The count cap bounds the ring even if the format
            // reports degenerate (NaN/zero) durations.
            while (self.audioRingDuration > Self.audioRingSeconds || self.audioRing.count > 200)
                && self.audioRing.count > 1 {
                let dropped = self.audioRing.removeFirst()
                let dropDur = dropped.frameLength / dropped.format.sampleRate
                if dropDur.isFinite && dropDur > 0 { self.audioRingDuration -= dropDur }
            }
            self.ringLock.unlock()
            self.request?.append(buffer)
        }

        do {
            try engine.start()
        } catch {
            status = "Couldn't start the microphone"
            inputNode.removeTap(onBus: 0)
            return
        }

        audioEngine = engine
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                DispatchQueue.main.async {
                    // STALE-TASK GUARD (9255c3f0 rework, review M1) — checked
                    // ON MAIN at execution time: only the CURRENT task may
                    // touch the transcript. A task cancelled at a rotation
                    // can still deliver a late result; a post-stop final is
                    // fine (it refines the text during the grace window).
                    guard self.request === req else { return }
                    self.absorbTranscript(text, finalized: result.isFinal)
                    // MID-UTTERANCE isFinal (9255c3f0): on long audio the
                    // on-device task delivers isFinal early with only the
                    // newest seconds. absorb() seals that text and the seal
                    // starts a FRESH task immediately — the session keeps
                    // recording and the tap keeps feeding audio (no deaf
                    // window). A user-requested stop ends the session: a
                    // send-final finishes instantly, a dictation cancel
                    // waits out the grace timer.
                    guard result.isFinal, self.state == .recording else { return }
                    if self.stoppingForSend {
                        self.finishRecording(send: true)
                    } else if !self.stopping {
                        self.rotateSegment()
                    }
                }
                return
            }
            if error != nil {
                // STALE-TASK GUARD on the error branch too (review M1): the
                // OUTGOING task's cancellation error also surfaces here —
                // never tear down a live session because an old task died.
                DispatchQueue.main.async {
                    guard self.request === req, !self.stopping else { return }
                    self.finishRecording(send: false)
                }
            }
        }
        state = .recording
        // Rotation clock: every segmentSeconds the active segment is sealed
        // and a fresh task takes over (see rotateSegment). The tap itself
        // never stops, so no audio is lost across the seam.
        rotationTimer?.invalidate()
        rotationTimer = Timer.scheduledTimer(withTimeInterval: Self.segmentSeconds, repeats: true) { [weak self] _ in
            self?.rotateSegment()
        }
        status = "● Listening… (press ⇧⌘Space again to send)"
    }

    // MARK: - Long-utterance segmentation (ticket 9255c3f0)

    /// Seal the active segment on a time boundary and hand the fresh task a
    /// short ring of trailing audio so the boundary lands between words.
    /// Called from the rotation timer and after a mid-utterance isFinal while
    /// state == .recording. The seal cursor is the transcript's CURRENT
    /// length (everything heard so far is sealed) — never 0: resetting it at
    /// the seam was what discarded sealed text in the rework's first cut.
    private func rotateSegment() {
        guard state == .recording, !stopping else { return }
        sealedText = fullTranscript
        liveSegment = ""
        // The ring re-hears the tail of what was just sealed: capture it as
        // the dedupe baseline for this segment's absorbs (ringTail).
        ringTail = Self.ringWords(of: sealedText)
        ringLock.lock()
        let pending = audioRing
        audioRing = []
        audioRingDuration = 0
        ringLock.unlock()
        let oldRequest = request
        let oldTask = task
        // endAudio on the OLD request only; the tap keeps feeding BOTH the
        // ring and (once the new request is installed) the live request, so
        // no audio is lost across the seam.
        oldRequest?.endAudio()
        oldTask?.finish()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if let recognizer = recognizer, recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        request = req
        for buffer in pending { req.append(buffer) }
        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                DispatchQueue.main.async {
                    // A cancelled task's late result must not touch the fresh
                    // segment (only the CURRENT task's results are absorbed;
                    // the identity check runs ON MAIN at execution time).
                    guard self.request === req else { return }
                    self.absorbTranscript(text, finalized: result.isFinal)
                    guard result.isFinal, self.state == .recording, !self.stopping else { return }
                    // The seam task finalized early: rotate on immediately
                    // (same contract as a mid-utterance isFinal).
                    self.rotateSegment()
                }
            }
            if error != nil {
                // The OUTGOING task's cancellation error also surfaces here —
                // never tear down a live session because an old task died
                // (request === req on the ERROR branch too — review M1).
                DispatchQueue.main.async {
                    guard self.request === req, !self.stopping else { return }
                    self.finishRecording(send: self.stoppingForSend)
                }
            }
        }
    }

    /// PURE seam-dedupe merge (ticket 9255c3f0 rework) — no self, no UI, so
    /// Linux CI can run it semantically (Swift is compiled only on the build
    /// Mac; every behavior of the seam lives here and in its tests).
    ///
    /// The live task re-transcribes the trailing-audio ring (~1.5s — a short
    /// TAIL of the previous segment, never the whole of a real 45s one), so
    /// the re-heard overlap is the longest SUFFIX of prevWords that matches a
    /// PREFIX of the new text (case-insensitive). The result is the previous
    /// live text rejoined with the genuinely-new tail:
    ///
    ///   mergeSegment("", "hello world")                  == "hello world"
    ///   mergeSegment("hello world", "world and more")    == "hello world and more"
    ///   mergeSegment("a b c d", "c d e f")               == "a b c d e f"
    ///   mergeSegment("hello world", "brand new audio")   // no overlap
    ///                                                    == "brand new audio"
    ///
    /// Empty liveText keeps the previous live segment (a refinement wave can
    /// arrive empty mid-segment); with NO matched overlap the task heard
    /// nothing it re-recognized, so its text REPLACES the segment (the old
    /// append-on-match-miss was the duplication B1 class).
    static func mergeSegment(_ prevLive: String, _ liveText: String) -> String {
        let trimmed = liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return prevLive }
        let prevWords = prevLive.split(separator: " ", omittingEmptySubsequences: false)
        let newWords = trimmed.split(separator: " ", omittingEmptySubsequences: false)
        var overlap = 0
        if !prevWords.isEmpty {
            let maxOverlap = min(prevWords.count, newWords.count)
            scan: for length in stride(from: maxOverlap, through: 1, by: -1) {
                var i = 0
                while i < length,
                      newWords[i].lowercased()
                          == prevWords[prevWords.count - length + i].lowercased() {
                    i += 1
                }
                if i == length { overlap = length; break scan }
            }
        }
        let fresh = newWords.dropFirst(overlap).joined(separator: " ")
        if overlap > 0 {
            return fresh.isEmpty ? prevLive : prevLive + " " + fresh
        }
        // No overlap matched: the fresh task heard nothing it re-recognized —
        // its text IS the live segment (replace, never append).
        return fresh
    }

    /// PURE ring-baselined seam dedupe (ticket 9255c3f0, review leg
    /// 2026-10-28) — no self, no UI, so Linux CI can run it semantically
    /// (Swift is compiled only on the build Mac). Returns the task's
    /// genuinely-new tail: its cumulative partial minus the words it merely
    /// RE-HEARD.
    ///
    /// The baseline is the ring tail (the last ~10 words of sealedText — the
    /// audio the fresh task was primed with at the seam), NOT the previous
    /// live segment: at a seam `rotateSegment` seals the full transcript and
    /// clears liveSegment BEFORE the fresh task can speak, so the FIRST
    /// post-seam result re-transcribes the ring while liveSegment is still
    /// empty — merging against "" duplicated the re-heard ring into the
    /// transcript (review BLOCKING finding). Basing EVERY absorb on the ring
    /// (fixed for the segment's lifetime) survives cumulative-partial
    /// refinement too: the second partial still begins with the ring words.
    ///
    ///   freshTail("", "world and more")        // ring "hello world"
    ///                                          == "and more"
    ///   freshTail("world", "and more")         == "and more"   // second partial
    ///   freshTail("and more", "and more x")    == "x"
    ///   freshTail("", "brand new audio")       // no ring overlap
    ///                                          == "brand new audio"
    ///   freshTail("anything", "   ")           == ""  // refinement wave
    ///
    /// mergeSegment is unchanged (its mirror tests keep proving the
    /// suffix/prefix machinery; this composes it with the ring baseline).
    static func freshTail(_ baseline: String, _ liveText: String) -> String {
        let trimmed = liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        let merged = mergeSegment(baseline, trimmed)
        if merged == baseline { return "" }
        if merged.hasPrefix(baseline + " ") {
            return String(merged.dropFirst(baseline.count + 1))
        }
        // No overlap matched (replace branch): the whole text is new.
        return merged
    }

    /// The last `maxWords` words of `text` — the ring's known words for the
    /// dedupe baseline (a ~1.5s ring re-hears roughly the last phrase).
    static func ringWords(of text: String, maxWords: Int = 10) -> String {
        let words = text.split(separator: " ")
        guard words.count > maxWords else { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        return words.suffix(maxWords).joined(separator: " ")
    }

    /// Fold a recognition result from the CURRENT task into the split
    /// transcript: the task's cumulative partial minus its re-heard ring
    /// overlap becomes liveSegment; sealedText is untouched (it was sealed at
    /// the last rotation and is never re-submitted to any task).
    private func absorbTranscript(_ liveText: String, finalized: Bool) {
        liveSegment = mergeLive(liveText)
        if finalized {
            // The current task is done: everything it heard is authoritative.
            // A MID-UTTERANCE isFinal seals nothing here — rotateSegment()
            // seals the full transcript and starts the fresh task (the
            // session keeps recording — 9255c3f0).
            sealedText = fullTranscript
            liveSegment = ""
        }
        let words = fullTranscript.split(separator: " ").count
        status = words == 0 ? "● Listening…" : "● \(words) words"
    }

    /// liveSegment fold for the current segment: dedupe against the ring
    /// baseline (ringTail) FIRST (it owns the seam words), then refine
    /// in-place against the previous live text.
    private func mergeLive(_ liveText: String) -> String {
        let fresh = Self.freshTail(ringTail, liveText)
        if fresh.isEmpty && !liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // The task has produced nothing beyond the ring yet.
            return liveSegment
        }
        return Self.mergeSegment(liveSegment, fresh)
    }

    /// Menu/shortcut stop: freeze the audio and let the recognizer's isFinal
    /// (or the finalize-grace timer) deliver the transcript to the composer.
    private func stopRecording(send: Bool) {
        guard state == .recording else { return }
        stoppingForSend = send
        // Latch the stop: the rotation timer is dead, a mid-grace isFinal may
        // refine the text but must not rotate, and a stale task's late result
        // must not resurrect the transcript after finish.
        stopping = true
        rotationTimer?.invalidate()
        rotationTimer = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        ringLock.lock()
        audioRing = []
        audioRingDuration = 0
        ringLock.unlock()
        request?.endAudio()
        // NO ring drain here (review leg 2026-10-28): the tap has been
        // UNgated since the rework, so the live request already heard every
        // buffered frame — re-appending the ring fed the recognizer the
        // tail twice. The old drain was correct only under the cursor-gated
        // tap. status text on the send path is still text-free.
        status = send ? "Transcribing…" : "Cancelled"
        // A send:false stop is DICTATION'S NORMAL END (9255c3f0 rework): the
        // transcript is the user's text and survives to the composer — the
        // old wipe made every dictation cancel throw the words away.
        cancelFinalizeTimer()
        finalizeTimer = Timer.scheduledTimer(withTimeInterval: Self.finalizeGrace, repeats: false) { [weak self] _ in
            self?.finishRecording(send: send)
        }
    }

    /// Terminal recording path — tears down audio + task exactly once.
    private func finishRecording(send: Bool) {
        guard state == .recording else { return }
        state = .idle
        stopping = true
        cancelFinalizeTimer()
        rotationTimer?.invalidate()
        rotationTimer = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        // ARC owns the buffers — dropping the ring releases them (the old
        // manual retain/release balancing was un-Swift and leaked nothing
        // anyway; the removal is the ARC idiom).
        ringLock.lock()
        audioRing = []
        audioRingDuration = 0
        ringLock.unlock()
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        audioEngine = nil

        let text = fullTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        sealedText = ""
        liveSegment = ""
        if dictating {
            dictating = false
            if text.isEmpty {
                status = "No speech detected"
            } else {
                // Dictation status stays TEXT-FREE (9255c3f0): status feeds
                // the window title, and echoing the transcript there is the
                // exact reported bug — the words belong in the composer.
                status = "Dictated \(text.split(separator: " ").count) words — edit and send"
                insertIntoComposer(text)
            }
            postVoiceState("idle")
            return
        }
        if send && !text.isEmpty {
            submitToChat(text)
        } else {
            status = "Voice ready"
        }
    }

    private func cancelFinalizeTimer() {
        finalizeTimer?.invalidate()
        finalizeTimer = nil
    }

    // MARK: - LLM turn (JS bridge into the loaded chat UI)

    private func jsStringLiteral(_ s: String) -> String {
        // Safe single-quoted JS literal for arbitrary transcript text.
        var out = ""
        for u in s.unicodeScalars {
            switch u {
            case "\\": out += "\\\\"
            case "'": out += "\\'"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if u.value < 0x20 {
                    // Remaining C0 controls (NUL/BS/VT/FF…) are syntax errors
                    // in a JS string literal — escape them all (review L3).
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return "'\(out)'"
    }

    /// Dictation: append the transcript to the focused/last visible composer
    /// through the native value setter + an input event (React-controlled
    /// textarea) — NO submit gesture; the user edits and sends it themselves.
    private func insertIntoComposer(_ text: String) {
        guard let webView = webView else { return }
        let literal = jsStringLiteral(text)
        let insert = """
        (function() {
          const active = document.activeElement;
          const tas = [...document.querySelectorAll('textarea')]
            .filter(e => e.offsetParent !== null && !e.disabled && !e.readOnly);
          const el = (active && active.tagName === 'TEXTAREA' && tas.includes(active)) ? active : tas[tas.length - 1];
          if (!el) return { ok: false, reason: 'no-textarea' };
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value').set;
          const cur = el.value || '';
          setter.call(el, cur ? cur + ' ' + \(literal) : \(literal));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        })()
        """
        webView.evaluateJavaScript(insert) { [weak self] result, error in
            guard let self = self else { return }
            let ok = (result as? [String: Any])?["ok"] as? Bool ?? false
            self.status = (error != nil || !ok)
                ? "Couldn't reach the composer — click into a chat and retry"
                : "Voice ready"
        }
    }

    private func submitToChat(_ text: String) {
        guard let webView = webView else { return }
        // Text-free status (9255c3f0): status feeds the window title, so the
        // outgoing message must not be echoed there (the old Sending-text
        // status put the user's words in the title bar too).
        status = "Sending voice message…"
        let literal = jsStringLiteral(text)
        // Insert via the NATIVE value setter (React-controlled textarea: a
        // plain .value write is invisible to it) + an input event, then the
        // ⌘Enter submit gesture (ChatComposerTextarea onKeyDown: metaKey Enter
        // submits in BOTH the chat and coding composer variants).
        let insertAndSend = """
        (function() {
          const tas = [...document.querySelectorAll('textarea')]
            .filter(e => e.offsetParent !== null && !e.disabled && !e.readOnly);
          const el = tas[tas.length - 1];
          if (!el) return { ok: false, reason: 'no-textarea' };
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, \(literal));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(() => {
            el.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', metaKey: true,
              bubbles: true, cancelable: true,
            }));
          }, 50);
          return { ok: true };
        })()
        """
        webView.evaluateJavaScript(insertAndSend) { [weak self] result, error in
            guard let self = self else { return }
            let ok = (result as? [String: Any])?["ok"] as? Bool ?? false
            if error != nil || !ok {
                self.status = "Couldn't reach the composer — click into a chat and retry"
                self.state = .idle
                return
            }
            if self.speakReplies {
                self.state = .awaitingReply
                self.status = "Waiting for the reply…"
                self.armReplyWatcher()
            } else {
                self.state = .idle
                self.status = "Sent (voice replies off)"
            }
        }
    }

    // MARK: - TTS out (ride the web app's own Read-aloud)

    /// Polls the page: composer's Stop button appears (run live) → disappears
    /// (run done) → 1.5s settle → click the LAST "Read aloud" button (the
    /// newest assistant message). Reports back over the `digby` bridge as
    /// {type:'voice', event:'replyStarted'|'replyTimeout'|'replyFailed'}.
    private func armReplyWatcher() {
        let watcher = """
        (function() {
          if (window.__digbyVoiceWatcher) return true; // one at a time
          window.__digbyVoiceWatcher = true;
          const post = (ev, extra) => {
            try {
              window.webkit.messageHandlers.digby.postMessage(
                Object.assign({ type: 'voice', event: ev }, extra || {}));
            } catch (e) {}
          };
          const done = () => { window.__digbyVoiceWatcher = false; };
          // The composer Stop button titles are 'Stop generating' / 'Stop the
          // run' (ChatComposer) — anchored so an unrelated 'Stop sharing'/
          // 'Stop reading' (the TTS button mid-playback) can't fake a run.
          const stopBtn = () => [...document.querySelectorAll('button[title]')]
            .find(b => /^stop (generating|the run)/i.test(b.title || ''));
          const readAloudBtns = () => [...document.querySelectorAll('button[title]')]
            .filter(b => /read aloud/i.test(b.title || ''));
          let phase = 'arm';
          let t0 = Date.now();
          const iv = setInterval(() => {
            // cancelAwaitingReply clears the guard — self-terminate the tick
            // (the interval id is IIFE-local, unreachable from outside; review M2).
            if (!window.__digbyVoiceWatcher) { clearInterval(iv); return; }
            const now = Date.now();
            if (phase === 'arm') {
              if (stopBtn()) { phase = 'running'; }
              else if (now - t0 > 15000) {
                clearInterval(iv); done(); post('replyTimeout', { phase: 'arm' });
              }
            } else if (phase === 'running') {
              if (!stopBtn()) { phase = 'settle'; t0 = now; }
              else if (now - t0 > 240000) {
                clearInterval(iv); done(); post('replyTimeout', { phase: 'running' });
              }
            } else if (phase === 'settle') {
              if (stopBtn()) { phase = 'running'; return; } // a follow-up run started
              if (now - t0 > 1500) {
                clearInterval(iv); done();
                const btns = readAloudBtns();
                if (btns.length) { btns[btns.length - 1].click(); post('replyStarted'); }
                else post('replyFailed', { reason: 'no-read-aloud' });
              }
            }
          }, 400);
          return true;
        })()
        """
        webView?.evaluateJavaScript(watcher, completionHandler: nil)
    }

    private func cancelAwaitingReply() {
        // Drop native state; the page-side watcher sees a new Stop cycle and
        // its own timeouts, or gets replaced on the next arm (the
        // __digbyVoiceWatcher guard is cleared by clearing via JS).
        state = .idle
        status = "Voice ready"
        webView?.evaluateJavaScript("window.__digbyVoiceWatcher = false;", completionHandler: nil)
    }

    // MARK: - Bridge events from the page

    func handleBridgeEvent(_ body: [String: Any]) {
        guard let event = body["event"] as? String else { return }
        switch event {
        case "dictate":
            toggleDictation()
        case "replyStarted":
            state = .idle
            status = "Speaking the reply…"
            // Return to a neutral status once playback has had time to start.
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                if self?.state == .idle { self?.status = "Voice ready" }
            }
        case "replyTimeout":
            state = .idle
            status = "Reply took too long — press the message's speaker icon"
        case "replyFailed":
            state = .idle
            status = "Reply ready — press the message's speaker icon to hear it"
        default:
            break
        }
    }
}
