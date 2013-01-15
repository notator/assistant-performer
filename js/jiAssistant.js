/*
*  copyright 2012 James Ingram
*  http://james-ingram-act-two.de/
*
*  Code licensed under MIT
*  https://github.com/notator/assistant-performer/blob/master/License.md
*
*  jiAssistant.js
*  The JI_NAMESPACE.assistant namespace which defines the
*    Assistant() constructor. 
*/

JI_NAMESPACE.namespace('JI_NAMESPACE.assistant');

JI_NAMESPACE.assistant = (function (window)
{
    "use strict";
    // begin var
    var 
    outputDevice,
    tracksControl,
    // MCD contains the following constant fields used for creating midi messages
    // {
    //     createMIDIMessage: MIDIAccess.createMIDIMessage,
    //     // MIDI commands
    //     NOTE_OFF: 0x80,
    //     NOTE_ON: 0x90,
    //     CONTROL_CHANGE: 0xB0,
    //     PROGRAM_CHANGE: 0xC0,
    //     CHANNEL_PRESSURE: 0xD0,
    //     PITCH_BEND: 0xE0,
    //     // MIDI controls
    //     PAN_CONTROL: 10,
    //     MODWHEEL_CONTROL: 1,
    //     EXPRESSION_CONTROL: 11
    // }
    MCD,

    // midi input message types
    UNKNOWN = 0,
    ILLEGAL_INDEX = 1,
    END_OF_SEQUENCE = 2,
    CHANNEL_PRESSURE = 3, // generated by my E-MU keyboard, when "Aftertouch" is switched on.
    AFTERTOUCH = 4, // from EWI breath controller
    MODULATION_WHEEL = 5, // from EWI bite controller or E-MU modulation wheel
    PITCH_WHEEL = 6, // from EWI pitch bend controllers or E-MU pitch wheel
    NOTE_ON = 7,
    NOTE_OFF = 8,

    options, // performance options. This is the options object in jiAPControls. 
    reportEndOfPerformance, // callback
    completeMidiTracksData, // argument for reportEndOfPerformance
    reportMsPosition, // callback

    // An array of subsequence. Each subsequence is a Sequence.
    // There is one subsequence for each chord or rest symbol in the live performer's track, whereby
    // consecutive rests have one subsequence.
    allSubsequences,

    // The array of subsequence actually performed (from fromMs to toMs). Constructed in playSpan() from allSubsequences.
    // The first subsequence in span may be the second part of a subsequence which has been split at fromMs.
    // The last subsequence in span may be the first part of a subsequence which has been split at toMs.
    span,

    // these variables are initialized by playSpan() and used by handleMIDIInputEvent() 
    endIndex = -1,
    currentIndex = -1, // the index of the currently playing subsequence (which will be stopped when a noteOn or noteOff arrives).
    nextIndex = 0, // the index of the subsequence which will be played when a noteOn msg arrives
    performanceStartNow, // set when the first subsequence starts, used to rectify timestamps when subsequences stop 
    subsequenceStartNow, // set when a subsequence starts, used to rectify timestamps when it stops, and in the relative durations option 
    prevSubsequenceStartNow = 0.0, // used only with the relative durations option
    pausedNow = 0.0, // used only with the relative durations option (the time at which the subsequence was paused).

    stopped = true,
    paused = false,
    midiInputEventHandler, // set in Assistant constructor, passed to options.getInputDevice(midiInputEventHandler) when state is set to running
    sendMIDIMessage, // callback. sendMIDIMessage(outputDevice, midiMessage)

    currentLivePerformersKeyPitch = -1, // -1 means "no key depressed". This value is set when the live performer sends a noteO

    init = function (messageCreationData, sendMessageCallback)
    {
        MCD = messageCreationData;
        sendMIDIMessage = sendMessageCallback;
    },

    setState = function (state)
    {

        function closeInputDevice(options)
        {
            // if (options.inputDevice !== undefined && options.inputDevice !== null)
            // {
            //     options.inputDevice.close();
            // }
        }

        switch (state)
        {
            case "stopped":
                if (currentIndex >= 0 && span[currentIndex].isStopped() === false)
                {
                    span[currentIndex].stop();
                }
                // these variables are also set in playSpan() when the state is first set to "running"
                endIndex = (span === undefined) ? -1 : (span.length - 1); // the index of the (unplayed) end chord or rest or endBarline
                currentIndex = -1;
                nextIndex = 0;
                prevSubsequenceStartNow = 0.0; // used only with the relative durations option
                pausedNow = 0.0; // used only with the relative durations option (the time at which the subsequence was paused).
                stopped = true;
                paused = false;
                closeInputDevice(options);
                break;
            case "paused":
                stopped = false;
                paused = true;
                closeInputDevice(options);
                break;
            case "running":
                stopped = false;
                paused = false;
                options.getInputDevice(midiInputEventHandler);
                break;
            default:
                throw "Unknown sequencer state!";
        }
    },

    // Can only be called when paused is true.
    resume = function ()
    {
        if (paused === true)
        {
            if (options.assistantUsesAbsoluteDurations === false)
            {
                subsequenceStartNow = window.performance.now();
                prevSubsequenceStartNow += (subsequenceStartNow - pausedNow);
            }
            span[currentIndex].resume();
            setState("running");
        }
    },

    // Can only be called while running
    // (stopped === false && paused === false)
    pause = function ()
    {
        if (stopped === false && paused === false)
        {
            pausedNow = window.performance.now();

            span[currentIndex].pause();
            setState("paused");
        }
        else
        {
            throw "Attempt to pause a stopped or paused sequence.";
        }
    },

    isStopped = function ()
    {
        return stopped === true;
    },

    isPaused = function ()
    {
        return paused === true;
    },

    stop = function ()
    {
        var i, nSubsequences, endOfPerformanceTimestamp;

        if (stopped === false)
        {
            nSubsequences = span.length;

            setState("stopped");

            if (options.assistantUsesAbsoluteDurations === false)
            {
                // reset the span
                // (During the assisted performance, the message.timestamps have changed according
                //  to the live performer's speed, but the midiMoment.timestamps have not).
                for (i = 0; i < nSubsequences; ++i)
                {
                    span[i].revertMessageTimestamps();
                }
            }

            endOfPerformanceTimestamp = window.performance.now() - performanceStartNow;

            reportEndOfPerformance(completeMidiTracksData, endOfPerformanceTimestamp, true);
        }
    },

    // If options.assistedPerformance === true, this is where input MIDI messages arrive, and where processing is going to be done.
    // Uses 
    //  endIndex  (= span.length -1 when stopped),
    //  currentIndex (= -1 when stopped) the index of the currently playing subsequence (which should be stopped when a noteOn or noteOff arrives).
    //  nextIndex (= 0 when stopped) the index of the subsequence which will be played when a noteOn msg arrives
    handleMIDIInputEvent = function (inputEvent)
    {
        var inputEventType, command, cmd,
            mcd = MCD;

        function inputCommand(inputEvent)
        {
            return (inputEvent.data[0] & 0xF0) >> 8;
        }

        function inputChannel(inputEvent)
        {
            return (inputEvent.data[0] & 0xF);
        }

        function inputData1(inputEvent)
        {
            return inputEvent.data[1];
        }

        function inputData2(inputEvent)
        {
            return inputEvent.data[2];
        }

        function inputTimestamp(inputEvent)
        {
            return inputEvent.receivedTime;
        }

        function inputEventToString(inputEvent)
        {
            var 
            command = inputCommand(inputEvent),
            channel = inputChannel(inputEvent),
            data1 = inputData1(inputEvent),
            data2 = inputData2(inputEvent),
            timestamp = inputTimestamp(inputEvent);

            return "Input event: command:".concat(command).concat(", channel:").concat(channel).concat(", data1:").concat(data1).concat(", data2:").concat(data2).concat(", timestamp:").concat(timestamp);
        }

        // getInputEventType returns one of the following constants:
        // UNKNOWN = 0, ILLEGAL_INDEX = 1, END_OF_SEQUENCE = 2, CHANNEL_PRESSURE = 3, AFTERTOUCH = 4,
        // MODULATION_WHEEL = 5, PITCH_WHEEL = 6, NOTE_ON = 7, NOTE_OFF = 8
        function getInputEventType(inputEvent)
        {
            var 
            command = inputCommand(inputEvent),
            type = UNKNOWN;

            switch (command)
            {
                case 0x80:
                    type = NOTE_OFF;
                    break;
                case 0x90:
                    if (inputData2(inputEvent) === 0) // velocity 0
                    {
                        type = NOTE_OFF;
                    }
                    else
                    {
                        type = NOTE_ON;
                    }
                    break;
                case 0xA0:
                    // generated by EWI controller
                    type = AFTERTOUCH;
                    break;
                case 0xB0:
                    if (inputData1(inputEvent) === 1)
                    {
                        type = MODULATION_WHEEL;
                    }
                    break;
                case 0xD0:
                    // This type is generated by my E-MU keyboard when "Aftertouch" is switched on.
                    type = CHANNEL_PRESSURE;
                    break;
                case 0xE0:
                    type = PITCH_WHEEL;
                    break;
                default:
                    type = UNKNOWN;
                    break;
            }

            return type;
        }

        // mcd contains message creation utilities ( see Main() )
        // controlData is one of the following objects (see jiAPControls.js):
        // { name: "channel pressure", statusHighNibble: 0xD0 },
        // { name: "pitch wheel", statusHighNibble: 0xE0 },
        // { name: "modulation (1)", midiControl: 1 },
        // { name: "volume (7)", midiControl: 7 },
        // { name: "pan (10)", midiControl: 10 },
        // { name: "expression (11)", midiControl: 11 },
        // { name: "timbre (71)", midiControl: 71 },
        // { name: "brightness (74)", midiControl: 74 },
        // { name: "effects (91)", midiControl: 91 },
        // { name: "tremolo (92)", midiControl: 92 },
        // { name: "chorus (93)", midiControl: 93 },
        // { name: "celeste (94)", midiControl: 94 },
        // { name: "phaser (95)", midiControl: 95 }
        // channel is the new message's channel
        // value is the new message's value
        function newControlMessage(mcd, controlData, channel, value)
        {
            var message;

            if (controlData.midiControl !== undefined)
            {
                // a normal control
                message = mcd.createMIDIMessage(mcd.CONTROL_CHANGE, controlData.midiControl, value, channel, 0);
            }
            else if (controlData.statusHighNibble !== undefined)
            {
                // pitch-bend or channel pressure
                if (controlData.statusHighNibble === mcd.PITCH_BEND)
                {
                    message = mcd.createMIDIMessage(controlData.statusHighNibble, 0, value, channel, 0);
                }
                else if (controlData.statusHighNibble === mcd.CHANNEL_PRESSURE)
                {
                    // ACHTUNG: The value goes to data1. Does this message work? Does Jazz send the right number of bytes?
                    message = mcd.createMIDIMessage(controlData.statusHighNibble, value, 0, channel, 0);
                }
                else
                {
                    throw "Illegal controlData.";
                }
            }
            else
            {
                throw "Illegal controlData.";
            }

            return message;
        }

        function handleController(mcd, controlData, value, usesSoloTrack, usesOtherTracks)
        {
            var controlMessages = [], nControlMessages, i,
                nTracks = allSubsequences[0].tracks.length,
                send = sendMIDIMessage;

            if (usesSoloTrack && usesOtherTracks)
            {
                for (i = 0; i < nTracks; ++i)
                {
                    if (tracksControl.trackIsOn(i))
                    {
                        controlMessages.push(newControlMessage(mcd, controlData, i, value));
                    }
                }
            }
            else if (usesSoloTrack)
            {
                controlMessages.push(newControlMessage(mcd, controlData, options.livePerformersTrackIndex, value));
            }
            else if (usesOtherTracks)
            {
                for (i = 0; i < nTracks; ++i)
                {
                    if (tracksControl.trackIsOn(i) && i !== options.livePerformersTrackIndex)
                    {
                        controlMessages.push(newControlMessage(mcd, controlData, i, value));
                    }
                }
            }
            else
            {
                throw "Either usesSoloTrack or usesOtherTracks must be set here.";
            }

            nControlMessages = controlMessages.length;
            for (i = 0; i < nControlMessages; ++i)
            {
                send(outputDevice, controlMessages[i]);
            }
        }

        function silentlyCompleteCurrentlyPlayingSubsequence()
        {
            // currentIndex is the index of the currently playing subsequence
            // (which should be silently completed when a noteOn arrives).
            if (currentIndex >= 0 && currentIndex < span.length)
            {
                span[currentIndex].finishSilently();
            }
        }

        // Pushes clones of the recorded messages, with corrected timestamps, into the completeMidiTracksData.
        // The clones are deleted in stop() after calling reportEndOfPerformance().
        // Subsequence calls this function with two more arguments, but those arguments are deliberately ignored here.
        function reportEndOfSubsequence(midiTracksData)
        {
            function collectMidiTracksData(completeMidiTracksData, midiTracksData)
            {
                var i, j, nMessages, newMessages, allTrackMessages, msg, msgClone,
                nTracks = completeMidiTracksData.length,
                sequenceStartTimeRePerformanceStart = subsequenceStartNow - performanceStartNow,
                previousTimestamp = 0,
                mcd = MCD; // local pointer -- could be quicker

                for (i = 0; i < nTracks; ++i)
                {
                    allTrackMessages = completeMidiTracksData[i];
                    if (allTrackMessages.length === 0)
                    {
                        previousTimestamp = 0;
                    }
                    else
                    {
                        previousTimestamp = allTrackMessages[allTrackMessages.length - 1].timestamp;
                    }

                    newMessages = midiTracksData[i];
                    nMessages = newMessages.length;
                    for (j = 0; j < nMessages; ++j)
                    {
                        msg = newMessages[j];
                        msgClone = mcd.createMIDIMessage(msg.command, msg.data1, msg.data2, msg.channel, msg.timestamp);
                        msgClone.timestamp += sequenceStartTimeRePerformanceStart;
                        if (msgClone.timestamp < previousTimestamp)
                        {
                            // This can happen in extreme situations with a very fast live performer.
                            msgClone.timestamp = previousTimestamp;
                            console.log("Negative timestamp corrected.");
                        }
                        allTrackMessages.push(msgClone);
                        previousTimestamp = msgClone.timestamp;
                    }
                }
            }

            collectMidiTracksData(completeMidiTracksData, midiTracksData);

            if (currentLivePerformersKeyPitch === -1) // key is up
            {
                if (currentIndex === endIndex)
                {
                    stop();
                }
                else if (span[nextIndex].chordSubsequence !== undefined)
                {
                    reportMsPosition(span[nextIndex].msPositionInScore);
                }
            }
            else if (nextIndex <= endIndex && span[nextIndex].restSubsequence !== undefined)
            {
                reportMsPosition(span[nextIndex].msPositionInScore);
            }
            // else wait for noteOff event (see handleNoteOff below).
        }

        function playSubsequence(subsequence, options)
        {
            var prevSubsequenceScoreMsDuration,
                durationFactor;

            if (options.assistantUsesAbsoluteDurations === false)
            {
                if (currentIndex > 0)
                {
                    prevSubsequenceScoreMsDuration = span[currentIndex].msPositionInScore - span[currentIndex - 1].msPositionInScore;
                    durationFactor = (subsequenceStartNow - prevSubsequenceStartNow) / prevSubsequenceScoreMsDuration;
                    // durations in the subsequence are multiplied by durationFactor
                    subsequence.changeMessageTimestamps(durationFactor);
                }
                prevSubsequenceStartNow = subsequenceStartNow; // used only with the relative durations option
            }

            // if options.assistantUsesAbsoluteDurations === true, the durations will already be correct in all subsequences.
            subsequence.playSpan(outputDevice, 0, Number.MAX_VALUE, tracksControl, reportEndOfSubsequence, reportMsPosition);
        }

        function handleNoteOff(inputEvent)
        {
            //console.log("NoteOff, pitch:", inputData1(inputEvent).toString(), " velocity:", inputEvent.data2.toString());

            if (inputData1(inputEvent) === currentLivePerformersKeyPitch)
            {
                currentLivePerformersKeyPitch = -1;

                silentlyCompleteCurrentlyPlayingSubsequence();

                if (currentIndex === endIndex) // see reportEndOfSpan() above 
                {
                    stop();
                }
                else if (span[nextIndex].restSubsequence !== undefined) // only play the next subsequence if it is a restSubsequence
                {
                    currentIndex = nextIndex++;
                    subsequenceStartNow = inputEvent.receivedTime;
                    playSubsequence(span[currentIndex], options);
                }
                else if (nextIndex <= endIndex)
                {
                    reportMsPosition(span[nextIndex].msPositionInScore);
                }
            }
        }

        function handleNoteOn(mcd, inputEvent, overrideSoloPitch, overrideOtherTracksPitch, overrideSoloVelocity, overrideOtherTracksVelocity)
        {
            var subsequence;

            //console.log("NoteOn, pitch:", inputData1(inputEvent).toString(), " velocity:", inputData2(inputEvent).toString());

            subsequenceStartNow = inputTimestamp(inputEvent);

            currentLivePerformersKeyPitch = inputData1(inputEvent);

            if (inputData2(inputEvent) > 0)
            {
                silentlyCompleteCurrentlyPlayingSubsequence();

                if (nextIndex === 0)
                {
                    performanceStartNow = inputTimestamp(inputEvent);
                    subsequenceStartNow = performanceStartNow;
                }
                else
                {
                    subsequenceStartNow = inputTimestamp(inputEvent);
                }

                if (nextIndex === 0 || (nextIndex <= endIndex && span[nextIndex].chordSubsequence !== undefined))
                {
                    currentIndex = nextIndex++;
                    subsequence = span[currentIndex];
                    if (overrideSoloPitch || overrideOtherTracksPitch || overrideSoloVelocity || overrideOtherTracksVelocity)
                    {
                        subsequence.overridePitchAndOrVelocity(mcd.NOTE_ON, options.livePerformersTrackIndex,
                            inputData1(inputEvent), inputData2(inputEvent),
                            overrideSoloPitch, overrideOtherTracksPitch, overrideSoloVelocity, overrideOtherTracksVelocity);
                    }
                    playSubsequence(subsequence, options);
                }
            }
            else // velocity 0 is "noteOff"
            {
                handleNoteOff(inputEvent);
            }
        }

        inputEventType = getInputEventType(inputEvent);

        switch (inputEventType)
        {
            case CHANNEL_PRESSURE: // EMU "aftertouch"
                console.log("Channel (=key) Pressure, value:", inputData1(inputEvent).toString());
                if (options.pressureSubstituteControlData !== null)
                {
                    handleController(mcd, options.pressureSubstituteControlData, inputData1(inputEvent), // ACHTUNG! data1 is correct!
                                                options.usesPressureSolo, options.usesPressureOtherTracks);
                }
                break;
            case AFTERTOUCH: // EWI breath controller
                console.log("Aftertouch, value:", inputData2(inputEvent).toString());
                if (options.pressureSubstituteControlData !== null)
                {
                    handleController(mcd, options.pressureSubstituteControlData, inputData2(inputEvent),
                                                options.usesPressureSolo, options.usesPressureOtherTracks);
                }
                break;
            case MODULATION_WHEEL: // EWI bite, EMU modulation wheel
                console.log("Modulation Wheel, value:", inputData2(inputEvent).toString());
                if (options.modSubstituteControlData !== null)
                {
                    handleController(mcd, options.modSubstituteControlData, inputData2(inputEvent),
                                                options.usesModSolo, options.usesModOtherTracks);
                }
                break;
            case PITCH_WHEEL: // EWI pitch bend up/down controllers, EMU pitch wheel
                console.log("Pitch Wheel, value:", inputData2(inputEvent).toString());
                if (options.pitchBendSubstituteControlData !== null)
                {
                    handleController(mcd, options.pitchBendSubstituteControlData, inputData2(inputEvent),
                                                options.usesPitchBendSolo, options.usesPitchBendOtherTracks);
                }
                break;
            case NOTE_ON:
                handleNoteOn(mcd, inputEvent,
                    options.overrideSoloPitch, options.overrideOtherTracksPitch,
                    options.overrideSoloVelocity, options.overrideOtherTracksVelocity);
                break;
            case NOTE_OFF:
                handleNoteOff(inputEvent);
                break;
            case END_OF_SEQUENCE:
                stop();
                break;
            case UNKNOWN:
                // This might be program change (0xC0 = 192) or system exclusive (0xF0 = 240),
                // neither of which I'm currently expecting in the input.
                command = inputCommand(inputEvent);
                cmd = null;
                if (command === 0xC0)
                {
                    cmd = "PROGRAM CHANGE";
                }
                else
                {
                    cmd = "SYSTEM EXCLUSIVE";
                }
                if (cmd !== null)
                {
                    throw "Unexpected " + cmd + " command in input";
                }
                else
                {
                    throw "Error: Unexpected controller message ".concat(inputEventToString(inputEvent));
                }
            case ILLEGAL_INDEX:
                throw "illegal index";
        }
    },

    // This function is called when options.assistedPerformance === true and the Go button is clicked (in the performance controls).
    // If options.assistedPerformance === false, the main sequence.playSpan(...) is called instead.
    // The assistant's allSubsequences array contains the whole piece as an array of sequence, with one sequence per performer's
    // rest or chord, whereby consecutive rests in the performer's track have been merged.
    // This function first constructs a span, which is the section of the allSubsequences array between fromMs and toMs.
    // Creating the span does *not* change the data in allSubsequences. The start and end markers can therefore be moved between
    // performances
    playSpan = function (outDevice, fromMs, toMs, svgTracksControl)
    {
        function getSpan(allSubsequences, fromMs, toMs)
        {
            var nSubsequences = allSubsequences.length,
                i = nSubsequences - 1,
                maxIndex = i, lastSubsequence,
                subsequence = null,
                span = [];

            if (i > 0)
            {
                subsequence = allSubsequences[i];
                while (i > 0 && subsequence.msPositionInScore > fromMs)
                {
                    --i;
                    subsequence = allSubsequences[i];
                }
            }

            // subsequence.msPositionInScore <= fromMs
            if (subsequence.restSubsequence !== undefined && subsequence.msPositionInScore < fromMs)
            {
                subsequence = subsequence.afterSplit(fromMs); // afterSplit() returns a new restSubsequence starting at fromMs
            }

            span.push(subsequence); // the first subsequence

            while (i < maxIndex)
            {
                ++i;
                subsequence = allSubsequences[i];
                if (subsequence.msPositionInScore >= toMs)
                {
                    break;
                }
                span.push(subsequence);
            }

            lastSubsequence = span.pop();

            // lastSubsequence.msPositionInScore < toMs
            if (lastSubsequence.restSubsequence !== undefined)
            {
                // beforeSplit() returns a new subsequence which is
                // a copy of the beginning of lastSubsequence up to (but not including) toMs,
                // to which a "finalBarline" moment has been added.
                lastSubsequence = lastSubsequence.beforeSplit(toMs);
            }

            //finalBarline = finalBarlineSubsequence(lastSubsequence.tracks.length, toMs);
            span.push(lastSubsequence);

            return span;
        }

        setState("running");
        outputDevice = outDevice;
        tracksControl = svgTracksControl;
        span = getSpan(allSubsequences, fromMs, toMs);

        endIndex = span.length - 1;
        currentIndex = -1;
        nextIndex = 0;
        prevSubsequenceStartNow = -1;
    },

    // creats an Assistant, complete with private subsequences
    // called when the Start button is clicked, and options.assistedPerformance === true
    Assistant = function (sequence, apControlOptions, reportEndOfWholePerformance, reportMillisecondPosition)
    {
        var i, nTracks;

        if (!(this instanceof Assistant))
        {
            return new Assistant(sequence, apControlOptions, reportEndOfWholePerformance, reportMillisecondPosition);
        }

        if (apControlOptions === undefined || apControlOptions.assistedPerformance !== true)
        {
            throw ("Error creating Assistant.");
        }

        options = apControlOptions;
        midiInputEventHandler = handleMIDIInputEvent;

        setState("stopped");

        reportEndOfPerformance = reportEndOfWholePerformance; // returns completeMidiTracksData;
        completeMidiTracksData = [];
        reportMsPosition = reportMillisecondPosition;

        allSubsequences = sequence.getSubsequences(options.livePerformersTrackIndex);

        nTracks = allSubsequences[0].tracks.length;
        for (i = 0; i < nTracks; ++i)
        {
            completeMidiTracksData.push([]);
        }

        // Starts an assisted performance 
        this.playSpan = playSpan;

        // these are called by the performance controls
        this.pause = pause; // pause()        
        this.resume = resume; // resume()
        this.stop = stop; // stop()

        this.isStopped = isStopped; // isStopped()
        this.isPaused = isPaused; // isPaused()

        this.subsequences = allSubsequences; // consulted by score when setting start and end marker positions.
    },

    publicAPI =
    {
        init: init,

        // empty Assistant constructor
        Assistant: Assistant
    };
    // end var

    return publicAPI;

} (window));
