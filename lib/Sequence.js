/*
*  Copyright 2012 James Ingram
*  http://james-ingram-act-two.de/
*
*  Code licensed under MIT
*  https://github.com/notator/assistant-performer/blob/master/License.md
*
*  Sequence.js
*  The MIDI_API.sequence namespace which defines the
*    Sequence(msPositionInScore) empty sequence constructor.
*
*  Public Interface (See longer descriptions in the code.):
*
*      // an array of Tracks
*      tracks
*
*      // The point in the score at which this Sequence begins.
*      // This value is set when the Sequence is constructed, and should never change.
*      // If there is no score, the Sequence constructor should be called with no arguments,
*      // in which case msPositionInScore defaults to 0.
*      msPositionInScore
*
*      // Start playing (part of) the Sequence.
*      // Arguments:
*      // midiOutdevice: the output device
*      // fromMsPositionInScore, toMsPositionInScore: the span of the sequence to play (not including toMsPositionInScore)
*      // trackIsOnArray[trackIndex] returns a boolean which determine whether the track will
*      //       be played or not. This array belongs to the caller, and is read only.
*      // [optional] reportEndOfSeqCallback: called when the performance ends.
*      // [optional] reportMsPositionCallback: called whenever a cursor needs to be updated
*      //       in the score.
*      playSpan(midiOutDevice, fromMsPositionInScore, toMsPositionInScore, trackIsOnArray,
*               reportEndOfSeqCallback, reportMsPositionCallback)
*
*      // pause a running performance
*      pause(),
*
*      // resume a paused performance
*      resume()
*
*      // stop a running performance
*      stop()
*
*      // Is the performance stopped?
*      isStopped(),
*
*      // Is the performance paused()?
*      isPaused()
*/

/*jslint bitwise: false, nomen: false, plusplus: true, white: true */


MIDI_API.namespace('MIDI_API.sequence');

MIDI_API.sequence = (function (window)
{
    "use strict";
    var
    CMD = MIDI_API.constants.COMMAND,
    UNDEFINED_TIMESTAMP = MIDI_API.constants.ASSISTANT_PERFORMER.UNDEFINED_TIMESTAMP,

    // An empty sequence is created. It contains an empty array of MIDI_API.track.Tracks.
    // The msPositionInScore argument defaults to 0.
    Sequence = function (msPositionInScore)
    {
        if (!(this instanceof Sequence))
        {
            return new Sequence(msPositionInScore);
        }

        this.tracks = []; // an array of Tracks
        Object.defineProperty(this, "msPositionInScore", { value: msPositionInScore, writable: false });
    },

    publicSequenceAPI =
    {
        // creates an empty sequence
        Sequence: Sequence
    };
    // end var

    Sequence.prototype = (function (window)
    {
        var
        // used by setState()
        currentMoment = null, // nextMoment(), resume(), tick()
        eventIndex = -1, // nextMoment()
        currentMomentLength = 0, // nextMoment()
        stopped = true, // nextMoment(), stop(), pause(), resume(), isStopped()
        paused = false, // nextMoment(), pause(), isPaused()

        that, // closure variable set by playSpan(), used by nextMoment()

        maxDeviation, // for console.log, set to 0 when performance starts
        midiOutputDevice, // set in playSpan(), used by tick()
        reportEndOfSequence, // callback. Can be null or undefined. Set in playSpan().
        reportMsPositionInScore,  // callback. Can be null or undefined. Set in playSpan().

        startTimeOffset = 0, // set in playSpan() and resume(), used by tick()

        endMarkerMsPositionInScore = -1,  // set in playSpan(), used by nextMoment()
        startNow = -1,  // set in playSpan(), used by nextMoment()
        finalBarlineMsPositionInScore = -1, // set in playSpan(), used by nextMoment()
        recordingSequence, // set in playSpan() and resume(), used by tick()
        lastReportedMsPosition = -1, // set by tick() used by nextMoment()
        msPositionToReport = -1,   // set in nextMoment() and used by tick()

        setState = function (state)
        {
            switch (state)
            {
                case "stopped":
                    currentMoment = null;
                    eventIndex = -1;
                    currentMomentLength = 0;
                    stopped = true;
                    paused = false;
                    break;
                case "paused":
                    stopped = false;
                    paused = true;
                    break;
                case "running":
                    stopped = false;
                    paused = false;
                    break;
                default:
                    throw "Unknown sequence state!";
            }
        },

        // Can only be called while running
        // (stopped === false && paused === false)
        pause = function ()
        {
            if (stopped === false && paused === false)
            {
                setState("paused");
            }
            else
            {
                throw "Attempt to pause a stopped or paused sequence.";
            }
        },

        // does nothing if the sequence is already stopped
        stop = function ()
        {
            var
            endNow = window.performance.now(),
            sequenceDuration = Math.ceil(endNow - startNow);

            if (stopped === false)
            {
                setState("stopped");
                if (reportEndOfSequence !== undefined && reportEndOfSequence !== null)
                {
                    reportEndOfSequence(recordingSequence, sequenceDuration);
                }
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

        // used by tick(), resume(), playSpan(), finishSilently()
        // Returns either the next moment in the sequence, or null if there are no more moments.
        // The next moment in the sequence is the earliest moment indexed by any of the
        // track.currentIndex indices, or null if track.currentIndex > track.toIndex in all tracks.
        nextMoment = function ()
        {
            var
            the = that, // that is set in playSpan(). Maybe using a local variable is faster...
            nTracks = the.tracks.length,
            track, i, currentTrack,
            moment, minMsPositionInScore = Number.MAX_VALUE,
            nextMomt = null;

            if (!stopped && !paused)
            {
                // first find nextMomentTrackIndex
                for (i = 0; i < nTracks; ++i)
                {
                    track = the.tracks[i];
                    if (track.isPerforming && track.currentIndex <= track.toIndex) // toIndex is the last valid index
                    {
                        moment = track.moments[track.currentIndex];
                        if (moment.minMsPositionInScore < minMsPositionInScore)
                        {
                            nextMomt = moment;
                            minMsPositionInScore = moment.timestamp;
                            currentTrack = track;
                        }
                    }
                }

                // nextMomt is now either null (= end of span) or the next moment.

                if (nextMomt !== null)
                {
                    // Only perform the last moment in the span if it is the last moment in the sequence.
                    if (currentTrack.currentIndex < currentTrack.toIndex || currentTrack.currentIndex === currentTrack.moments.length)
                    {
                        currentTrack.currentIndex++;

                        if (reportMsPositionInScore !== undefined && reportMsPositionInScore !== null
                        && (nextMomt.chordStart || nextMomt.restStart) // These attributes are set when loading a score.
                        && (nextMomt.msPositionInScore > lastReportedMsPosition))
                        {
                            // the position will be reported by tick() when the next moment is sent.
                            msPositionToReport = nextMomt.msPositionInScore;
                        }

                        nextMomt.timestamp = nextMomt.msPositionInScore + startTimeOffset;
                    }
                    else
                    {
                        nextMomt = null; // tells tick() to stop.
                        stop(); // calls reportEndOfSequence()
                    }
                }
            }

            return nextMomt;
        },

        // tick() function -- which ws a lot to Chris Wilson of the Web Audio Group
        // Recursive function. Also used by resume(), playSpan()
        // This function has been tested as far as possible without having "a conformant outputDevice.send() with timestamps".
        // It needs testing again with the conformant outputDevice.send() and a higher value for PREQUEUE. What would the
        // ideal value for PREQUEUE be? 
        // Email correspondence with Chris Wilson (End of Oct. 2012):
        //      James: "...how do I decide how big PREQUEUE should be?"
        //      Chris: "Well, you're trading off two things:
        //          - 'precision' of visual display (though keep in mind that is fundamentally limited to the 16.67ms tick
        //            of the visual refresh rate (for a 60Hz display) - and that also affects how quickly you can respond
        //            to tempo changes (or stopping/pausing playback).
        //          - reliance on how accurate the setTimeout/setInterval clock is (for that reason alone, the lookahead
        //            probably needs to be >5ms).
        //          So, in short, you'll just have to test on your target systems."
        //      James: "Yes, that's more or less what I thought. I'll start testing with PREQUEUE at 16.67ms."
        //
        // 16th Nov. 2012: The cursor can only be updated once per tick, so PREQUEUE needs to be small enough for that not
        // to matter.
        // 18th Jan. 2013 -- Jazz 1.2 does not support timestamps.
        //
        // The following variables are initialised in playSpan() to start playing that sequence:
        //      currentMoment // the first moment in the sequence
        //      track attributes:
        //          isPerforming // set by referring to the track control
        //          fromIndex // the index of the first moment in the track to play
        //          toIndex // the index of the final moment in the track (which does not play)
        //          currentIndex // = fromIndex
        //      endMarkerMsPositionInScore // the toMsPositionInScore argument to playSpan()
        //      finalBarlineMsPositionInScore // the largest msPositionInScore in any track (i.e. the end of the sequence)
        //      maxDeviation = 0; // just for console.log
        //      midiOutputDevice // the midi output device
        //      reportEndOfSequence // can be null
        //      reportMsPosition // can be null    
        tick = function ()
        {
            var
            momt = currentMoment, // local variable may be faster
            deviation,
            PREQUEUE = 0, // needs to be set to a larger value later. See above.
            now = window.performance.now(),
            delay;

            // momt.timestamps are always absolute DOMHRT values here.
            // (Chris said that the timestamp should be absolute DOMHRT time when the moment is sent.)
            // Note that Jazz 1.2 does not support timestamps. It always sends Messages immediately.
            function sendMessages(moment)
            {
                var
                messages = moment.messages,
                i, nMessages = messages.length, timestamp = moment.timestamp;

                for (i = 0; i < nMessages; ++i)
                {
                    midiOutputDevice.send(messages[i].data, timestamp);
                }
            }

            if (momt === null)
            {
                console.log("Pause, or end of sequence.  maxDeviation is " + maxDeviation + "ms");
                return;
            }

            delay = momt.timestamp - now; // compensates for inaccuracies in setTimeout
            //console.log("tick: delay = " + delay);
            // send all messages that are due between now and PREQUEUE ms later. 
            while (delay <= PREQUEUE)
            {
                // these values are only used by console.log (See end of file too!)
                deviation = (now - momt.timestamp);
                maxDeviation = (deviation > maxDeviation) ? deviation : maxDeviation;

                if (msPositionToReport > 0)
                {
                    reportMsPositionInScore(msPositionToReport);
                    lastReportedMsPosition = msPositionToReport; // lastReportedMsPosition is used in nextMoment() above.
                    msPositionToReport = -1;
                }

                if (momt.messages.length > 0) // rest moments can be empty (but should be reported above) 
                {
                    sendMessages(momt);

                    if (recordingSequence !== undefined && recordingSequence !== null)
                    {
                        // The moments are recorded with absolute DOMHRT timestamp values.
                        // These values are adjusted relative to the first moment.timestamp
                        // before saving them in a Standard MIDI File.
                        // (i.e. the value of the earliest timestamp in the recording is
                        // subtracted from all the timestamps in the recording) 
                        // After saving the recording, the momt.timestamps are reset to
                        // UNDEFINED_TIMESTAMP.
                        // Note that addMoment() uses moment.msPositionInScore to order
                        // the moments in the track, but that timestamp values are read when
                        // saving the Standard MIDI file.
                        recordingSequence.tracks[momt.messages[0].channel()].addMoment(momt);
                    }
                    else
                    {
                        momt.timestamp = UNDEFINED_TIMESTAMP;
                    }
                }

                currentMoment = nextMoment();

                if (currentMoment === null)
                {
                    // we're pausing, or have hit the end of the sequence.
                    //console.log("Pause, or end of sequence.  maxDeviation is " + maxDeviation + "ms");
                    return;
                }
                delay = currentMoment.timestamp - now;
            }

            window.setTimeout(tick, delay);  // that will schedule the next tick.
        },

        // Can only be called when paused is true.
        resume = function ()
        {
            var resumeAtDOMHRTime;

            function resetTimestamps(resumeAtTimestamp)
            {
                var
                i, j, tracks = that.tracks, nTracks = tracks.length, track;

                for (i = 0; i < nTracks; ++i)
                {
                    track = tracks[i];
                    for (j = track.currentIndex; j <= track.toIndex; ++j)
                    {
                        track.moments[j].timeIndex += resumeAtTimestamp;
                    }
                }
            }

            if (paused === true && currentMoment !== null)
            {
                setState("running");
                resumeAtDOMHRTime = window.performance.now() - currentMoment.timestamp;
                resetTimestamps(resumeAtDOMHRTime);

                currentMoment = nextMoment(); // the first moment after the resume
                if (currentMoment === null)
                {
                    // This shouldn't be hit, except for an empty initial sequence
                    return;
                }
                tick();
            }
        },

        // playSpan();
        // Note that the final Moment (at toMsPositionInScore) is often at the final barline
        // (which may or may not contain noteOff Messages).
        //
        // trackIsOnArray[trackIndex] returns a boolean which determines whether the track will
        // be played or not. This array belongs to its creator, and is read only.
        //
        // recording is a Sequence to which timestamped moments are added as they are performed.
        // Can be undefined or null.
        //
        // The reportEndOfSeq argument is a callback function (having no arguments)
        // which is called when the last Message in the sequence or subsequence has been sent.
        // Can be undefined or null.
        //
        // The reportMsPosition argument is a callback function which reports the current
        // msPosition back to the GUI while performing. Can be undefined or null.
        // The msPosition it passes back is the original number of milliseconds
        // from the start of the score. This value is used to identify chord and rest symbols
        // in the score, and so to synchronize the running cursor. It is explicitly different
        // from the timestamp used when sending Messages.
        //
        // When this function is called, the moment.timestamps should all be set to UNDEFINED_TIMESTAMP.
        // The moment.timestamps are set here to the absolute DOMHRTime at which the moment should be sent.
        playSpan = function (midiOutDevice, fromMsPositionInScore, toMsPositionInScore, trackIsOnArray,
                                recording, reportEndOfSeq, reportMsPosition)
        {
            // Sets finalBarlineMsPositionInScore to the largest moment.msPositionInScore in tracks[0].
            function getFinalBarlineMsPositionInScore()
            {
                var track = that.tracks[0],
                finalBarlineMsPositionInScore = track.moments[track.moments.length - 1].msPositionInScore;

                return finalBarlineMsPositionInScore;
            }

            // Sets each track's isPerforming attribute. If the track is performing,
            // its fromIndex, currentIndex and toIndex attributes are also set.
            // Sets each performing track to contain all the moments between msOffsetFromStartOfScore
            // and toMsPositionInScore inclusive.
            // Note that the final Moment can be at the final barline (a restStart).
            // Loop through the moments in a track using for(i = track.fromIndex; i < track.toIndex; ++i)
            function setTrackAttributes(tracks, trackIsOnArray, msOffsetFromStartOfScore, toMsPositionInScore)
            {
                var
                i, nTracks = tracks.length, track,
                j, trackMoments, trackLength;

                for (i = 0; i < nTracks; ++i)
                {
                    track = tracks[i];
                    trackMoments = track.moments;
                    trackLength = trackMoments.length;

                    // trackLength can be 0, if nothing happens during
                    // the track (maybe during a during a subsequence)
                    if (trackLength === 0)
                    {
                        track.isPerforming = false;
                    }
                    else
                    {
                        track.isPerforming = trackIsOnArray[i];
                    }

                    if (track.isPerforming) // trackLength is > 0
                    {
                        for (j = 0; j < trackLength; ++j)
                        {
                            if (trackMoments[j].msPositionInScore >= msOffsetFromStartOfScore)
                            {
                                track.fromIndex = j;
                                break;
                            }
                        }
                        for (j = track.fromIndex; j < trackLength; ++j)
                        {
                            // The track's final position can be the position of the final barline. 
                            if (trackMoments[j].msPositionInScore <= toMsPositionInScore)
                            {
                                track.toIndex = j;
                            }
                            else
                            {
                                break;
                            }
                        }

                        track.currentIndex = track.fromIndex;
                    }
                }
            }

            // uses track.fromIndex to return the smallest moment.msPositionInScore in any track.
            function firstMsPosition(tracks)
            {
                var i, nTracks = tracks.length, track, msPosition, firstPosition = Number.MAX_VALUE;

                for (i = 0; i < nTracks; ++i)
                {
                    track = tracks[i];
                    msPosition = track.moments[track.fromIndex].msPositionInScore;
                    firstPosition = (firstMsPosition < msPosition) ? firstMsPosition : msPosition;
                }
                return firstPosition;
            }

            that = this;

            stop(); //  sets state to "stopped" if it isn't already.

            recordingSequence = recording; // can be undefined or null

            if (midiOutDevice === undefined || midiOutDevice === null)
            {
                throw "The midi output device must be defined.";
            }

            midiOutputDevice = midiOutDevice;
            reportEndOfSequence = reportEndOfSeq; // can be null or undefined
            reportMsPositionInScore = reportMsPosition; // can be null or undefined

            endMarkerMsPositionInScore = toMsPositionInScore;
            lastReportedMsPosition = -1;
            finalBarlineMsPositionInScore = getFinalBarlineMsPositionInScore();
            setState("running");

            maxDeviation = 0; // for console.log

            setTrackAttributes(that.tracks, trackIsOnArray, fromMsPositionInScore, toMsPositionInScore);

            // startNow is an integer used to calculate both startTimeOffset
            // and the total duration of the performance.
            startNow = Math.floor(window.performance.now());
            // In nextMoment(), setTimeOffset is used to set moment.timestamp
            // startTimeOffset + moment.msPositionInScore = moment.timestamp
            // moment.timestamp is then the absolute DOMHRTime at which to send the moment.
            startTimeOffset = startNow - firstMsPosition(that.tracks); 

            currentMoment = nextMoment(); // the very first moment
            if (currentMoment === null)
            {
                // This shouldn't be hit, except for an empty initial sequence
                return;
            }
            tick();
        },

        // When called, sends all the sequence's unsent messages, except noteOns, immediately.
        // These messages are not recorded.
        finishSilently = function ()
        {
            var
            i, nMessages, messages, message,
            moment = nextMoment(),
            now = window.performance.now();

            while (moment !== null)
            {
                nMessages = moment.messages.length;
                messages = moment.messages;
                for (i = 0; i < nMessages; ++i)
                {
                    message = messages[i];
                    if (!(message.command() === CMD.NOTE_ON && message.data[2] > 0))
                    {
                        midiOutputDevice.send(message.data, now);
                    }
                }
                moment = nextMoment();
            }
            stop();
        },

        publicPrototypeAPI =
        {
            playSpan: playSpan,
            pause: pause,
            resume: resume,
            stop: stop,
            isStopped: isStopped,
            isPaused: isPaused,
            finishSilently: finishSilently
        };

        return publicPrototypeAPI;

    } (window));

    return publicSequenceAPI;

} (window));


