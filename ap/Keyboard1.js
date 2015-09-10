/*
* copyright 2014 James Ingram
* http://james-ingram-act-two.de/
*
* Code licensed under MIT
* https://github.com/notator/assistant-performer/blob/master/License.md
*
* ap/Keyboard1.js
* The _AP.keyboard1 namespace which defines
*
* // Initialize Keyboard1
* // Arguments:
* // inputDevice: The midi input device.
* // outputdevice: The midi output device.
* // reportEndOfPerfCallback: a callback function which is called when performing sequence
* //      reaches the endMarkerMsPosition.
* //      It is called in this file as:
* //          reportEndOfSpan(sequenceRecording, performanceMsDuration);
* // reportMsPosCallback: a callback function which reports the current msPositionInScore
* //      back to the GUI while performing. Can be undefined or null.
* //      It is called here as:
* //          reportMsPositionInScore(msPositionToReport);
* //      The msPosition it passes back is the original number of milliseconds from the start of
* //      the score (taking the global speed option into account). This value is used to identify
* //      chord and rest symbols in the score, and so to synchronize the running cursor.
* init = function(inputDevice, outputDevice, reportEndOfPerfCallback, reportMsPosCallback)
* 
* // Start playing (part of) the Score.
* // Arguments:
* // trackIsOnArray an array containing a boolean per track, determining whether it will
* //      be played or not. This array is read only.
* // startMarkerMsPosition, endMarkerMsPosition: the part of the sequence to play 
* //      (not including endMarkerMsPosition)
* // [optional] recording: a sequence in which the performed messages will be recorded.
* play(trackIsOnArray, startMarkerMsPosInScore, endMarkerMsPosInScore, recording)
* 
* // stop a running performance
* stop()
* 
* // Is the performance stopped?
* isStopped()
* 
* // Is the performance running?
* isRunning()
* 
*/

/*jslint bitwise: true, nomen: true, plusplus: true, white: true, continue: true */
/*global _AP: false,  window: false,  document: false, performance: false, console: false, alert: false, XMLHttpRequest: false */

_AP.namespace('_AP.keyboard1');

_AP.keyboard1 = (function()
{
	"use strict";

	var
	inputDevice,
	outputDevice,

	currentInstantIndex, // initialized to 0 when playing starts. Is the index in the following array (used while performing).
	instants = [],
	indexPlayed, // set to currentInstantIndex when instants[currentInstantIndex] is played.

	inputTracks,
	outputTracks,
	trackWorkers = [], // an array of webWorkers, one per outputTrack (=trackIndex).
	keyInstantIndices = [],
	keyRange, // keyRange.bottomKey and keyRange.topKey are the bottom and top input midi key values notated in the score.

	reportEndOfSpan, // callback -- called here as reportEndOfSpan(sequenceRecording, performanceMsDuration);
	reportMsPositionInScore, // callback -- called here as reportMsPositionInScore(msPositionToReport);

	// (performance.now() - performanceStartTime) is the real time elapsed since the start of the performance.
	performanceStartTime = -1,  // set in play(), used by stop(), run()

	// used by setState()
	stopped = true, // stop(), isStopped()

	sequenceRecording, // the sequence being recorded.

	allControllersOffMessages = [],
	allNotesOffMessages = [],

	initChannelResetMessages = function(nOutputChannels)
	{
		var byte1, channelIndex,
			constants = _AP.constants,
			CONTROL_CHANGE = constants.COMMAND.CONTROL_CHANGE,
			ALL_CONTROLLERS_OFF = constants.CONTROL.ALL_CONTROLLERS_OFF,
			ALL_NOTES_OFF = constants.CONTROL.ALL_NOTES_OFF;

		for(channelIndex = 0; channelIndex < nOutputChannels; channelIndex++)
		{
			byte1 = CONTROL_CHANGE + channelIndex;
			allControllersOffMessages.push(new Uint8Array([byte1, ALL_CONTROLLERS_OFF, 0]));
			allNotesOffMessages.push(new Uint8Array([byte1, ALL_NOTES_OFF, 0]));
		}
	},

	handleMIDIInputEventForwardDeclaration,

	setState = function(state)
	{
		switch(state)
		{
			case "stopped":
				stopped = true;
				inputDevice.removeEventListener("midimessage", handleMIDIInputEventForwardDeclaration, false);
				inputDevice.close();
				break;
			case "running":
				stopped = false;
				inputDevice.addEventListener("midimessage", handleMIDIInputEventForwardDeclaration, false);
				inputDevice.open();
				break;
			default:
				throw "Unknown sequence state!";
		}
	},

	isRunning = function()
	{
		return (stopped === false);
	},

	isStopped = function()
	{
		return (stopped === true);
	},

	// does nothing if the performance is already stopped
	stop = function()
	{
		var performanceMsDuration, i;

		if(!isStopped())
		{
			for(i = 0; i < trackWorkers.length; ++i)
			{
				trackWorkers[i].terminate();
			}
			trackWorkers = [];

			setState("stopped"); // removes input device event handlers

			performanceMsDuration = Math.ceil(performance.now() - performanceStartTime);

			if(reportEndOfSpan !== undefined && reportEndOfSpan !== null)
			{
				reportEndOfSpan(sequenceRecording, performanceMsDuration);
			}
		}
	},

 	resetChannel = function(outputDevice, channelIndex, letSound)
	{
		if(letSound === false)
		{
			outputDevice.send(allControllersOffMessages[channelIndex], performance.now());
			outputDevice.send(allNotesOffMessages[channelIndex], performance.now());
		}
	},

	// trackWorkers send their messages here.
	handleTrackMessage = function(e)
	{
		var msg = e.data;

		function workerHasCompleted(trackIndex)
		{
			var i, performanceHasCompleted = true;

			trackWorkers[trackIndex].hasCompleted = true;

			for(i = 0; i < trackWorkers.length; i++)
			{
				if(trackWorkers[i].hasCompleted === false)
				{
					performanceHasCompleted = false;
					break;
				}
			}

			if(performanceHasCompleted === true)
			{
				stop();
			}
		}

		switch(msg.action)
		{
			case "midiMessage":
				// Note that Jazz 1.2 does not support timestamps. It always sends messages immediately.
				outputDevice.send(msg.midiMessage, performance.now());
				// TODO: recording
				//if(sequenceRecording !== undefined && sequenceRecording !== null)
				//{
				//	// The instants are recorded with their current (absolute DOMHRT) timestamp values.
				//	// These values are adjusted relative to the first moment.timestamp
				//	// before saving them in a Standard MIDI File.
				//	// (i.e. the value of the earliest timestamp in the recording is
				//	// subtracted from all the timestamps in the recording) 
				//	sequenceRecording.trackRecordings[currentMoment.messages[0].channel()].addLiveScoreMoment(currentMoment);
				//}
				break;
			case "trkCompleted":
				// TrackWorkers send this message to say that they are not going to send any more midiMessages from a trk (that is not the last).
				resetChannel(outputDevice, msg.channelIndex, msg.letSound);
				break;
			case "workerCompleted":
				// TrackWorkers send this message to say that they are not going to send any more midiMessages from their final trk.
				resetChannel(outputDevice, msg.channelIndex, msg.letSound);
				workerHasCompleted(msg.trackIndex);
				break;
			default:
				break;
		}
	},

	// see _Keyboard1Algorithm.txt
	// This handler
    // a) ignores both RealTime and SysEx messages in its input, and
    // b) assumes that RealTime messages will not interrupt the messages being received.    
    handleMIDIInputEvent = function(msg)
    {
    	var inputEvent, command,
    		CMD = _AP.constants.COMMAND;    	

    	// The returned object is either empty, or has .data and .receivedTime attributes,
    	// and so constitutes a timestamped Message. (Web MIDI API simply calls this an Event)
    	// This handler ignores both realTime and SysEx messages, even though these are
    	// defined (untested 8.3.2013) in the _AP library, so this function only returns
    	// the other types of message (having 2 or 3 data bytes).
    	// If the input data is undefined, an empty object is returned, otherwise data must
    	// be an array of numbers in range 0..0xF0. An exception is thrown if the data is illegal.
    	function getInputEvent(data, now)
    	{
    		var
            SYSTEM_EXCLUSIVE = _AP.constants.SYSTEM_EXCLUSIVE,
            isRealTimeStatus = _AP.constants.isRealTimeStatus,
            inputEvent = {};

    		if(data !== undefined)
    		{
    			if(data[0] === SYSTEM_EXCLUSIVE.START)
    			{
    				if(!(data.length > 2 && data[data.length - 1] === SYSTEM_EXCLUSIVE.END))
    				{
    					throw "Error in System Exclusive inputEvent.";
    				}
    				// SysExMessages are ignored by the assistant, so do nothing here.
    				// Note that SysExMessages may contain realTime messages at this point (they
    				// would have to be removed somehow before creating a sysEx event), but since
    				// we are ignoring both realTime and sysEx, nothing needs doing here.
    			}
    			else if((data[0] & 0xF0) === 0xF0)
    			{
    				if(!(isRealTimeStatus(data[0])))
    				{
    					throw "Error: illegal data.";
    				}
    				// RealTime messages are ignored by the assistant, so do nothing here.
    			}
    			else if(data.length === 2)
    			{
    				inputEvent = new _AP.message.Message(data[0], data[1], 0);
    			}
    			else if(data.length === 3)
    			{
    				inputEvent = new _AP.message.Message(data[0], data[1], data[2]);
    			}

    			// other data is simply ignored

    			if(inputEvent.data !== undefined)
    			{
    				inputEvent.receivedTime = now;
    			}
    		}

    		return inputEvent;
    	}

    	function playNoteOnOrOff(noteOnOrOff, performedVelocity)
    	{
    		function doPressures(pressures)
    		{
    			// TODO;
    		}
    		function doPitchWheels(pitchWheels)
    		{
    			// TODO;
    		}
    		function doModWheels(modWheels)
    		{
    			// TODO;
    		}
    		function doTrkOffs(trkOffs)
    		{
    			var i, tosLength = trkOffs.length;
    			for(i = 0; i < tosLength; ++i)
    			{
    				trackWorkers[trkOffs[i].trackIndex].postMessage({ action: "stop" });
    			}
    		}
    		if(noteOnOrOff.seq)
    		{
    			noteOnOrOff.seq.start(performedVelocity);
    		}
    		if(noteOnOrOff.pressures)
    		{
    			doPressures(noteOnOrOff.pressures);
    		}
    		if(noteOnOrOff.pitchWheels)
    		{
    			doPitchWheels(noteOnOrOff.pitchWheels);
    		}
    		if(noteOnOrOff.modWheels)
    		{
    			doModWheels(noteOnOrOff.modWheels);
    		}
    		if(noteOnOrOff.trkOffs)
    		{
    			doTrkOffs(noteOnOrOff.trkOffs);
    		}
    	}

    	// increment noteInfos.seq.index until all noteInfos.seqs are >= currentInstantIndex
    	function advanceCurrentKeyIndicesTo(currentInstantIndex)
    	{
    		var i, keyNoteOnOrOffs, noteOnOrOff;

    		for(i = 0; i < keyInstantIndices.length; ++i)
    		{
    			keyNoteOnOrOffs = keyInstantIndices[i];
    			if(keyNoteOnOrOffs !== undefined) // some keyInstantIndices may not have keyNoteOnOrOffs...
    			{
    				while(keyNoteOnOrOffs.index < keyNoteOnOrOffs.length)
    				{
    					noteOnOrOff = keyNoteOnOrOffs[keyNoteOnOrOffs.index];
    					if(noteOnOrOff.msPosIndex >= currentInstantIndex)
    					{
    						break;
    					}

    					playNoteOnOrOff(noteOnOrOff, 0);

    					keyNoteOnOrOffs.index++;
    				}
    			}
    		}
    	}

    	function handleNoteOff(key)
    	{
    		var keyIndex = key - keyRange.bottomKey, keyNoteOnOrOffs, noteOff, index;

    		if(key >= keyRange.bottomKey && key <= keyRange.topKey)
    		{
    			keyNoteOnOrOffs = keyInstantIndices[keyIndex];
    			if(keyNoteOnOrOffs.length > keyNoteOnOrOffs.index) // some keyInstantIndices may not have seqs...
    			{
    				noteOff = keyNoteOnOrOffs[keyNoteOnOrOffs.index++];
    				index = noteOff.msPosIndex;
    				if(index === currentInstantIndex || ((index === currentInstantIndex + 1) && indexPlayed === currentInstantIndex))  // legato realization
    				{
    					if(index === currentInstantIndex + 1)
    					{
    						currentInstantIndex++;
    						reportMsPositionInScore(instants[currentInstantIndex].msPosition);
    						advanceCurrentKeyIndicesTo(currentInstantIndex); // see above
    					}
    					// Note that performedVelocity is 0 when this function is called by either
    					// a real NoteOff or a NoteOn masquerading as a NoteOff.
    					playNoteOnOrOff(noteOff, 0);
    					indexPlayed = currentInstantIndex;
    				}
    			}
    		}
    	}

    	// Note that velocity will be 0 when this function is called by either
    	// a real NoteOff or a NoteOn masquerading as a NoteOff. 
    	function handleNoteOn(key, performedVelocity)
    	{
    		var keyIndex = key - keyRange.bottomKey, keyNoteOnOrOffs, noteOnOrOff, index;

    		if(key >= keyRange.bottomKey && key <= keyRange.topKey)
    		{
    			keyNoteOnOrOffs = keyInstantIndices[keyIndex];
    			if(keyNoteOnOrOffs.length > keyNoteOnOrOffs.index) // some keyInstantIndices may not have seqs...
    			{
    				noteOnOrOff = keyNoteOnOrOffs[keyNoteOnOrOffs.index++];
    				index = noteOnOrOff.msPosIndex;
    				if(index === currentInstantIndex || ((index === currentInstantIndex + 1) && indexPlayed === currentInstantIndex))  // legato realization
    				{
    					if(index === currentInstantIndex + 1)
    					{
    						currentInstantIndex++;
    						reportMsPositionInScore(instants[currentInstantIndex].msPosition);
    						advanceCurrentKeyIndicesTo(currentInstantIndex); // see above
    					}
    					console.log("performedVelocity=" + performedVelocity.toString(10));
    					playNoteOnOrOff(noteOnOrOff, performedVelocity);
    					indexPlayed = currentInstantIndex;
    				}
    			}
    		}
    	}

    	// called when channel pressure changes
    	// Achtung: value is data[1]
    	function handleChannelPressure(data)
    	{
    		var i, nWorkers = trackWorkers.length;

    		for(i = 0; i < nWorkers; ++i)
    		{
    			trackWorkers[i].postMessage({ action: "doController", controller: "pressure", value: data[1] }); // Achtung: data[1]
    		}
    	}

    	// called when modulation wheel changes
    	// Achtung: value is data[2]
    	function handleModWheel(data)
    	{
    		var i, nWorkers = trackWorkers.length;

    		for(i = 0; i < nWorkers; ++i)
    		{
    			trackWorkers[i].postMessage({ action: "doController", controller: "modWheel", value: data[2] }); // Achtung: data[2]
    		}
    	}

    	function handlePitchWheel(data)
    	{
    		var i, nWorkers = trackWorkers.length;

    		for(i = 0; i < nWorkers; ++i)
    		{
    			trackWorkers[i].postMessage({ action: "doPitchWheel", data1: data[1], data2: data[2] });
    		}
    	}

    	inputEvent = getInputEvent(msg.data, performance.now());

    	if(inputEvent.data !== undefined)
    	{
    		command = inputEvent.command();

    		switch(command)
    		{
    			case CMD.NOTE_ON:
    				if(inputEvent.data[2] !== 0)
    				{
    					handleNoteOn(inputEvent.data[1], inputEvent.data[2]);
    				}
    				else
    				{
    					handleNoteOff(inputEvent.data[1]);
    				}
    				break;
				case CMD.NOTE_OFF:
					handleNoteOff(inputEvent.data[1]);
    				break;
    			case CMD.CHANNEL_PRESSURE: // produced by both R2M and E-MU XBoard49 when using "aftertouch"
    				// CHANNEL_PRESSURE.data[1] is the amount of pressure 0..127.
    				handleChannelPressure(inputEvent.data);
    				break;
    			case CMD.AFTERTOUCH: // produced by the EWI breath controller
    				// AFTERTOUCH.data[1] is the MIDIpitch to which to apply the aftertouch
    				// AFTERTOUCH.data[2] is the amount of pressure 0..127.
    				// not supported
    				break;
    			case CMD.PITCH_WHEEL: // EWI pitch bend up/down controllers, EMU pitch wheel
    				handlePitchWheel(inputEvent.data);
    				break;
    			case CMD.CONTROL_CHANGE: // sent when the EMU ModWheel changes.
    				handleModWheel(inputEvent.data);
    				break;
    			default:
    				break;
    		}
    	}
    },

	// The reportEndOfPerfCallback argument is a callback function which is called when performing sequence
	// reaches the endMarkerMsPosition (see play(), or stop() is called. Can be undefined or null.
	// It is called in this file as:
	//      reportEndOfSpan(sequenceRecording, performanceMsDuration);
	// The reportMsPosCallback argument is a callback function which reports the current msPositionInScore back
	// to the GUI while performing. Can be undefined or null.
	// It is called here as:
	//      reportMsPositionInScore(msPositionToReport);
	// The msPosition it passes back is the original number of milliseconds from the start of
	// the score (taking the global speed option into account). This value is used to identify
	// chord and rest symbols in the score, and so to synchronize the running cursor.
	// Moments whose msPositionInScore is to be reported are given chordStart or restStart
	// attributes before play() is called.
	init = function(inputDeviceArg, outputDeviceArg, tracksData, reportEndOfPerfCallback, reportMsPosCallback)
	{
		console.assert((inputDeviceArg !== undefined && inputDeviceArg !== null), "The midi input device must be defined.");
		console.assert((outputDeviceArg !== undefined && outputDeviceArg !== null), "The midi output device must be defined.");
		console.assert((tracksData !== undefined && tracksData !== null), "The tracksData must be defined.");
		console.assert((tracksData.inputTracks !== undefined && tracksData.inputTracks !== null), "The input tracks must be defined.");
		console.assert((tracksData.outputTracks !== undefined && tracksData.outputTracks !== null), "The output tracks must be defined.");
		console.assert((tracksData.inputKeyRange !== undefined && tracksData.inputKeyRange !== null), "The input key range must be defined.");
		console.assert(!(reportEndOfPerfCallback === undefined || reportEndOfPerfCallback === null
						|| reportMsPosCallback === undefined || reportMsPosCallback === null),
						"Error: both the position reporting callbacks must be defined.");

		inputDevice = inputDeviceArg;
		outputDevice = outputDeviceArg;
		inputTracks = tracksData.inputTracks;
		outputTracks = tracksData.outputTracks;
		keyRange = tracksData.inputKeyRange; // these are the bottom and top midi key values notated in the score.
		reportEndOfSpan = reportEndOfPerfCallback;
		reportMsPositionInScore = reportMsPosCallback;

		initChannelResetMessages(outputTracks.length);

		setState("stopped");
	},

	// play()
	//
	// trackIsOnArray[trackIndex] returns a boolean which determines whether each output or input
	// track will be played or not. This array is read only.
	// recording is a Sequence to which timestamped instants are added as they are performed.
	// It should be an empty Sequence having the same number of output tracks as the score.
	play = function(trackIsOnArray, startMarkerMsPosInScore, endMarkerMsPosInScore, recording)
	{
		var channelIndex;

		function initPlay(trackIsOnArray, keyInstantIndices, instants, trackWorkers, startMarkerMsPosInScore, endMarkerMsPosInScore)
		{
			// Sets instants to contain an array of objects having noteOns and noteOffs array attributes (the arrays are undefined if empty).
			// The instants are ordered by msPosition, and do not contain the endMarkerMsPosInScore.
			// Each instant has an msPosition attribute, and contains all the NoteOns and NoteOffs at that msPosition,
			// regardless of inputTrack. All the msPositions are >= startMarkerMsPosInScore and < endMarkerMsPosInScore.
			// Each trk is given a trkOptions attribute object containing the options it needs. These depend on whether the
			// trk is inside a seq, pressures, pitchWheels or modWheels object.
			// The trkOptions objects that have been consumed, and are no longer required, are set to undefined.
			function setInstants(instants, inputTracks, trackIsOnArray, startMarkerMsPosInScore, endMarkerMsPosInScore)
			{
				var notesMoments, i, j, nNotesMoments,
					vNotesArray, nVNotes, note;

				function findObjectAtMsPosition(verticalArrays, msPosition)
				{
					var i, nArrays = verticalArrays.length, moment = null;

					for(i = 0; i < nArrays; ++i)
					{
						if(verticalArrays[i].msPosition === msPosition)
						{
							moment = verticalArrays[i];
							break;
						}
					}
					return moment;
				}

				// Returns an array of (array of inputNotes), ordered by msPosition (without the endMarkerMsPosInScore).
				// Each contained array has an msPosition attribute, and contains all the inputNotes at that msPosition,
				// regardless of inputTrack. All the msPositions are >= startMarkerMsPosInScore and < endMarkerMsPosInScore.
				// Each trk is given a trkOptions attribute object containing the options it needs.
				// These depend on whether the trk is inside a seq, pressures, pitchWheels or modWheels object.
				// The trkOptions objects that have been consumed are no longer needed are set to undefined.
				function getNotesMoments(inputTracks, trackIsOnArray, startMarkerMsPosInScore, endMarkerMsPosInScore)
				{
					var trackIndex, nTracks, ioIndex, inputObjects, nInputObjects, msPosition, msDuration, inputChord,
						notesMoments = [], performedNote, performedNotes, moment, i, nPerformedNotes,
						chordTrkOptions, previousChordTrkOptions;

					function getPerformedNotes(inputNotes, trackIsOnArray)
					{
						var performedNotes = [], i, nInputNotes = inputNotes.length;

						function usesTrack(inputNote, trackIsOnArray)
						{
							var rval = false;

							function hasTrack(trkArray, trackIsOnArray)
							{
								var rval = false, i, nTrks = trkArray.length;
								for(i = 0; i < nTrks; ++i)
								{
									if(trackIsOnArray[trkArray[i].trackIndex])
									{
										rval = true;
										break;
									}
								}
								return rval;
							}

							if(hasTrack(inputNote.noteOn.seq, trackIsOnArray)
							|| hasTrack(inputNote.noteOff.trkOffs, trackIsOnArray)
							|| hasTrack(inputNote.noteOn.pressures, trackIsOnArray)
							|| hasTrack(inputNote.noteOn.pitchWheels, trackIsOnArray)
							|| hasTrack(inputNote.noteOn.modWheels, trackIsOnArray)
							|| hasTrack(inputNote.noteOn.trkOffs, trackIsOnArray)
							|| hasTrack(inputNote.noteOff.seq, trackIsOnArray)
							|| hasTrack(inputNote.noteOff.pitchWheels, trackIsOnArray)
							|| hasTrack(inputNote.noteOff.modWheels, trackIsOnArray))
							{
								rval = true;
							}
							return rval;
						}

						for(i = 0; i < nInputNotes; ++i)
						{
							if(usesTrack(inputNotes[i], trackIsOnArray))
							{
								performedNotes.push(inputNotes[i]);
							}
						}

						return performedNotes;
					}

					function setNoteOnOffTrkOptions(note, chordTrkOptions)
					{
						function setTrkOptions(noteOnOff, noteTrkOptions, chordTrkOptions)
						{
							function getOption(optStr, trkTrkOptions, seqControlsTrkOptions, noteTrkOptions, chordTrkOptions)
							{
								var option;
								if(trkTrkOptions !== undefined && trkTrkOptions.hasOwnProperty(optStr))
								{
									option = trkTrkOptions[optStr];
								}
								else if(seqControlsTrkOptions !== undefined && seqControlsTrkOptions.hasOwnProperty(optStr))
								{
									option = seqControlsTrkOptions[optStr];
								}
								else if(noteTrkOptions !== undefined && noteTrkOptions.hasOwnProperty(optStr))
								{
									option = noteTrkOptions[optStr];
								}
								else if(chordTrkOptions !== undefined && chordTrkOptions.hasOwnProperty(optStr))
								{
									option = chordTrkOptions[optStr];
								}
								return option;

							}

							// Seqs use the options: pedal, velocity and trkOff
							function setSeqTrkOptions(seq, noteTrkOptions, chordTrkOptions)
							{
								var i, nTrks = seq.length, newTrkOptions, seqTrkOptions = seq.trkOptions, trkTrkOptions,
									pedalOpt, velocityOpt, minVelocityOpt, trkOffOpt;

								for(i = 0; i < nTrks; ++i)
								{
									newTrkOptions = {};
									trkTrkOptions = seq[i].trkOptions;
									pedalOpt = getOption("pedal", trkTrkOptions, seqTrkOptions, noteTrkOptions, chordTrkOptions);
									if(pedalOpt !== undefined)
									{
										newTrkOptions.pedal = pedalOpt;
									}
									velocityOpt = getOption("velocity", trkTrkOptions, seqTrkOptions, noteTrkOptions, chordTrkOptions);
									if(velocityOpt !== undefined)
									{
										minVelocityOpt = getOption("minVelocity", trkTrkOptions, seqTrkOptions, noteTrkOptions, chordTrkOptions);
										newTrkOptions.velocity = velocityOpt;
										newTrkOptions.minVelocity = minVelocityOpt;
									}
									trkOffOpt = getOption("trkOff", trkTrkOptions, seqTrkOptions, noteTrkOptions, chordTrkOptions);
									if(trkOffOpt !== undefined)
									{
										newTrkOptions.trkOff = trkOffOpt;
									}
									seq[i].trkOptions = newTrkOptions;
								}
								seq.trkOptions = undefined;
							}

							function setControlTrkOptions(optionString, controls, noteTrkOptions, chordTrkOptions)
							{
								var i, nControls = controls.length, newTrkOptions,
									controlsTrkOptions = controls.trkOptions, trkTrkOptions,
									option;

								for(i = 0; i < nControls; ++i)
								{
									newTrkOptions = {};
									trkTrkOptions = controls[i].trkOptions;
									option = getOption(optionString, trkTrkOptions, controlsTrkOptions, noteTrkOptions, chordTrkOptions);
									if(option !== undefined)
									{
										newTrkOptions[optionString] = option;
										switch(option)
										{
											case "volume":
												newTrkOptions.minVolume = getOption("minVolume", trkTrkOptions, controlsTrkOptions, noteTrkOptions, chordTrkOptions);
												newTrkOptions.maxVolume = getOption("maxVolume", trkTrkOptions, controlsTrkOptions, noteTrkOptions, chordTrkOptions);
												break;
											case "pitch":
												newTrkOptions.pitchWheelDeviation = getOption("pitchWheelDeviation", trkTrkOptions, controlsTrkOptions, noteTrkOptions, chordTrkOptions);
												break;
											case "pan":
												newTrkOptions.panOrigin = getOption("panOrigin", trkTrkOptions, controlsTrkOptions, noteTrkOptions, chordTrkOptions);
												break;
											case "speed":
												newTrkOptions.speedDeviation = getOption("speedDeviation", trkTrkOptions, controlsTrkOptions, noteTrkOptions, chordTrkOptions);
												break;
											default:
												break;
										}
									}
									controls[i].trkOptions = newTrkOptions;
								}
								controls.trkOptions = undefined;
							}

							if(noteOnOff.seq !== undefined)
							{
								setSeqTrkOptions(noteOnOff.seq, chordTrkOptions);
							}
							if(noteOnOff.pressures !== undefined)
							{
								setControlTrkOptions("pressure", noteOnOff.pressures, noteTrkOptions, chordTrkOptions);
							}
							if(noteOnOff.pitchWheels !== undefined)
							{
								setControlTrkOptions("pitchWheel", noteOnOff.pitchWheels, noteTrkOptions, chordTrkOptions);
							}
							if(noteOnOff.modWheels !== undefined)
							{
								setControlTrkOptions("modWheel", noteOnOff.modWheels, noteTrkOptions, chordTrkOptions);
							}
						}

						if(note.noteOn)
						{
							setTrkOptions(note.noteOn, note.trkOptions, chordTrkOptions);
						}

						if(note.noteOff)
						{
							setTrkOptions(note.noteOff, note.trkOptions, chordTrkOptions);
						}
						note.trkOptions = undefined;
					}

					nTracks = inputTracks.length;
					for(trackIndex = 0; trackIndex < nTracks; ++trackIndex)
					{
						if(trackIsOnArray[trackIndex])
						{
							previousChordTrkOptions = null;
							inputObjects = inputTracks[trackIndex].inputObjects;
							nInputObjects = inputObjects.length;
							for(ioIndex = 0; ioIndex < nInputObjects; ++ioIndex)
							{
								if(inputObjects[ioIndex] instanceof _AP.inputChord.InputChord)
								{
									inputChord = inputObjects[ioIndex];
									msPosition = inputChord.msPositionInScore;
									msDuration = inputChord.msDurationInScore;
									if(inputChord.trkOptions)
									{
										chordTrkOptions = inputChord.trkOptions;
									}
									else if(previousChordTrkOptions !== null)
									{
										chordTrkOptions = previousChordTrkOptions;
									}
									else
									{
										chordTrkOptions = new _AP.trkOptions.TrkOptions({});
									}
									previousChordTrkOptions = chordTrkOptions;

									if(msPosition >= startMarkerMsPosInScore && msPosition < endMarkerMsPosInScore)
									{
										performedNotes = getPerformedNotes(inputChord.inputNotes, trackIsOnArray);

										if(performedNotes.length > 0)
										{
											nPerformedNotes = performedNotes.length;
											moment = findObjectAtMsPosition(notesMoments, msPosition);
											if(moment === null)
											{
												moment = [];
												moment.msPosition = msPosition;
												notesMoments.push(moment);
											}
											for(i = 0; i < nPerformedNotes; ++i)
											{
												performedNote = performedNotes[i];
												performedNote.msDuration = msDuration;
												setNoteOnOffTrkOptions(performedNote, chordTrkOptions);
												moment.push(performedNote);
											}
										}
									}
								}
								inputChord.trkOptions = undefined;
							}
						}
					}

					// sort by msPositions
					notesMoments.sort(function(a, b) { return a.msPosition - b.msPosition; });

					return notesMoments;
				}

				function pushNoteOn(instants, noteOn, notatedKey, msPosition)
				{
					var instant;

					if(noteOn !== undefined)
					{
						instant = findObjectAtMsPosition(instants, msPosition);
						if(instant === null)
						{
							instant = {};
							instant.msPosition = msPosition;
							instants.push(instant);
						}
						if(instant.noteOns === undefined)
						{
							instant.noteOns = [];
						}

						noteOn.notatedKey = notatedKey;
						instant.noteOns.push(noteOn);
					}
				}

				function pushNoteOff(instants, noteOff, notatedKey, msPosition)
				{
					var instant;

					if(noteOff !== undefined)
					{
						instant = findObjectAtMsPosition(instants, msPosition);
						if(instant === null)
						{
							instant = {};
							instant.msPosition = msPosition;
							instants.push(instant);
						}
						if(instant.noteOffs === undefined)
						{
							instant.noteOffs = [];
						}
						noteOff.notatedKey = notatedKey;
						instant.noteOffs.push(noteOff);
					}
				}

				instants.length = 0;
				notesMoments = getNotesMoments(inputTracks, trackIsOnArray, startMarkerMsPosInScore, endMarkerMsPosInScore);
				nNotesMoments = notesMoments.length;
				for(i = 0; i < nNotesMoments; ++i)
				{
					vNotesArray = notesMoments[i];
					nVNotes = vNotesArray.length;
					for(j = 0; j < nVNotes; ++j)
					{
						note = vNotesArray[j];
						pushNoteOn(instants, note.noteOn, note.notatedKey, vNotesArray.msPosition);
						pushNoteOff(instants, note.noteOff, note.notatedKey, vNotesArray.msPosition + note.msDuration);
					}
				}

				// sort by msPositions
				instants.sort(function(a, b) { return a.msPosition - b.msPosition; });
			}

			// Replaces noteOn.seq and noteOff.seq definitions by Seq objects.
			// The Seq constructor posts pushTrk messages to the appropriate trackWorkers.
			// The seqs are being constructed in order of msPosition, so the trackWorkers' trks
			// are also in order of msPosition.
			function setSeqsAndTrackWorkers(instants, trackWorkers, outputTracks)
			{
				var i, instantIndex, nInstants = instants.length, instant, nNoteOns, nNoteOffs, noteOn, noteOff;

				function initTrackWorkers(trackWorkers, outputTracks)
				{
					var i, worker;

					trackWorkers.length = 0;

					for(i = 0; i < outputTracks.length; i++)
					{
						worker = new window.Worker("ap/TrackWorker.js");
						worker.addEventListener("message", handleTrackMessage);
						worker.postMessage({ action: "init", trackIndex: i, channelIndex: outputTracks[i].midiChannel });
						// worker.hasCompleted is set to false when a trk is added (in the Seq constructor),
						// and back to true when the worker says that it has completed its last trk.
						worker.hasCompleted = true;
						trackWorkers.push(worker);
					}
				}

				function setSeq(msPosition, noteOnOrOff, trackWorkers)
				{
					if(noteOnOrOff.seq)
					{
						noteOnOrOff.seq = new _AP.seq.Seq(msPosition, noteOnOrOff.seq, trackWorkers);
					}
				}

				initTrackWorkers(trackWorkers, outputTracks);

				for(instantIndex = 0; instantIndex < nInstants; ++instantIndex)
				{
					instant = instants[instantIndex];
					if(instant.noteOffs)
					{
						nNoteOffs = instant.noteOffs.length;
						for(i = 0; i < nNoteOffs; ++i)
						{
							noteOff = instant.noteOffs[i];
							setSeq(instant.msPosition, noteOff, trackWorkers);
						}
					}
					if(instant.noteOns)
					{
						nNoteOns = instant.noteOns.length;
						for(i = 0; i < nNoteOns; ++i)
						{
							noteOn = instant.noteOns[i];
							setSeq(instant.msPosition, noteOn, trackWorkers);
						}
					}
				}
			}

			// Creates a keyOnIndices and keyOffIndices array of instant indices for each Key in the played range.
			function setKeyInstantIndices(keyInstantIndices, instants)
			{
				var i, instantIndex, nInstants = instants.length, instant, nOnOrOffs, noteOn, noteOff;

				function initializeKeyInstantIndices(keyInstantIndices, bottomKey, topKey)
				{
					var i, keyIndices;

					keyInstantIndices.length = 0; // the keyboard1.keyInstantIndices array
					for(i = bottomKey; i <= topKey; ++i)
					{
						keyIndices = {};
						keyIndices.keyOnIndices = [];
						keyIndices.keyOffIndices = [];
						keyIndices.index = 0; // index in both the above arrays
						keyInstantIndices.push(keyIndices);
					}
				}

				initializeKeyInstantIndices(keyInstantIndices, keyRange.bottomKey, keyRange.topKey); // keyRange was set in keyboard1.init().

				for(instantIndex = 0; instantIndex < nInstants; ++instantIndex)
				{
					instant = instants[instantIndex];
					if(instant.noteOffs)
					{
						nOnOrOffs = instant.noteOffs.length;
						for(i = 0; i < nOnOrOffs; ++i)
						{
							noteOff = instant.noteOffs[i];
							keyInstantIndices[noteOff.notatedKey - keyRange.bottomKey].keyOffIndices.push(instantIndex);
						}
					}
					if(instant.noteOns)
					{
						nOnOrOffs = instant.noteOns.length;
						for(i = 0; i < nOnOrOffs; ++i)
						{
							noteOn = instant.noteOns[i];
							keyInstantIndices[noteOn.notatedKey - keyRange.bottomKey].keyOnIndices.push(instantIndex);
						}
					}
				}
			}

			setInstants(instants, inputTracks, trackIsOnArray, startMarkerMsPosInScore, endMarkerMsPosInScore);

			setSeqsAndTrackWorkers(instants, trackWorkers, outputTracks);

			setKeyInstantIndices(keyInstantIndices, instants);

			currentInstantIndex = 0; // the initial index in instants to perform
			indexPlayed = -1; // is set to currentInstantIndex when instants[currentInstantIndex] is played
		}

		sequenceRecording = recording;

		for(channelIndex = 0; channelIndex < outputTracks.length; channelIndex++)
		{
			resetChannel(outputDevice, channelIndex, false);
		}

		initPlay(trackIsOnArray, keyInstantIndices, instants, trackWorkers, startMarkerMsPosInScore, endMarkerMsPosInScore);

		performanceStartTime = performance.now();
		setState("running");
	},

	publicAPI =
	{
		init: init,

		play: play,
		stop: stop,
		isStopped: isStopped,
		isRunning: isRunning,

		handleMIDIInputEvent: handleMIDIInputEvent
	};
	// end var

	handleMIDIInputEventForwardDeclaration = handleMIDIInputEvent;

	return publicAPI;

}());
