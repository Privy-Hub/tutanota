//@flow
import type {CalendarMonthTimeRange} from "./CalendarUtils"
import {
	assignEventId, copyEvent,
	getAllDayDateForTimezone,
	getAllDayDateUTCFromZone,
	getDiffInDays,
	getEventEnd,
	getEventStart,
	getStartOfDayWithZone,
	getTimeZone,
	isLongEvent,
	isSameEvent
} from "./CalendarUtils"
import {isToday} from "../api/common/utils/DateUtils"
import {getFromMap} from "../api/common/utils/MapUtils"
import type {DeferredObject} from "../api/common/utils/Utils"
import {clone, defer, downcast, neverNull} from "../api/common/utils/Utils"
import type {AlarmIntervalEnum, EndTypeEnum, RepeatPeriodEnum} from "../api/common/TutanotaConstants"
import {AlarmInterval, EndType, FeatureType, GroupType, OperationType, RepeatPeriod} from "../api/common/TutanotaConstants"
import {DateTime, FixedOffsetZone, IANAZone} from "luxon"
import {isAllDayEvent, isAllDayEventByTimes} from "../api/common/utils/CommonCalendarUtils"
import {Notifications} from "../gui/Notifications"
import type {EntityUpdateData} from "../api/main/EventController"
import {EventController, isUpdateForTypeRef} from "../api/main/EventController"
import {worker} from "../api/main/WorkerClient"
import {locator} from "../api/main/MainLocator"
import {getElementId, HttpMethod, isSameId} from "../api/common/EntityFunctions"
import {erase, load, loadAll, serviceRequestVoid} from "../api/main/Entity"
import type {UserAlarmInfo} from "../api/entities/sys/UserAlarmInfo"
import {UserAlarmInfoTypeRef} from "../api/entities/sys/UserAlarmInfo"
import type {CalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import {CalendarEventTypeRef} from "../api/entities/tutanota/CalendarEvent"
import {formatDateWithWeekdayAndTime, formatTime} from "../misc/Formatter"
import {lang} from "../misc/LanguageViewModel"
import {isApp} from "../api/Env"
import {logins} from "../api/main/LoginController"
import {NotFoundError} from "../api/common/error/RestError"
import {client} from "../misc/ClientDetector"
import {insertIntoSortedArray} from "../api/common/utils/ArrayUtils"
import m from "mithril"
import {UserTypeRef} from "../api/entities/sys/User"
import type {CalendarGroupRoot} from "../api/entities/tutanota/CalendarGroupRoot"
import {CalendarGroupRootTypeRef} from "../api/entities/tutanota/CalendarGroupRoot"
import {GroupInfoTypeRef} from "../api/entities/sys/GroupInfo"
import type {CalendarInfo} from "./CalendarView"
import {mailModel} from "../mail/MailModel"
import {FileTypeRef} from "../api/entities/tutanota/File"
import {parseCalendarFile} from "./CalendarImporter"
import {module as replaced} from "@hot"
import type {CalendarEventUpdate} from "../api/entities/tutanota/CalendarEventUpdate"
import {CalendarEventUpdateTypeRef} from "../api/entities/tutanota/CalendarEventUpdate"
import {LazyLoaded} from "../api/common/utils/LazyLoaded"
import {createMembershipRemoveData} from "../api/entities/sys/MembershipRemoveData"
import {SysService} from "../api/entities/sys/Services"
import {GroupTypeRef} from "../api/entities/sys/Group"
import type {AlarmInfo} from "../api/entities/sys/AlarmInfo"


function eventComparator(l: CalendarEvent, r: CalendarEvent): number {
	return l.startTime.getTime() - r.startTime.getTime()
}

export function addDaysForEvent(events: Map<number, Array<CalendarEvent>>, event: CalendarEvent, month: CalendarMonthTimeRange,
                                zone: string = getTimeZone()) {
	const eventStart = getEventStart(event, zone)
	let calculationDate = getStartOfDayWithZone(eventStart, zone)
	const eventEndDate = getEventEnd(event, zone);

	// only add events when the start time is inside this month
	if (eventStart.getTime() < month.start.getTime() || eventStart.getTime() >= month.end.getTime()) {
		return
	}

	// if start time is in current month then also add events for subsequent months until event ends
	while (calculationDate.getTime() < eventEndDate.getTime()) {
		if (eventEndDate.getTime() >= month.start.getTime()) {
			insertIntoSortedArray(event, getFromMap(events, calculationDate.getTime(), () => []), eventComparator, isSameEvent)
		}
		calculationDate = incrementByRepeatPeriod(calculationDate, RepeatPeriod.DAILY, 1, zone)
	}
}

export function addDaysForRecurringEvent(events: Map<number, Array<CalendarEvent>>, event: CalendarEvent, month: CalendarMonthTimeRange,
                                         timeZone: string) {
	const repeatRule = event.repeatRule
	if (repeatRule == null) {
		throw new Error("Invalid argument: event doesn't have a repeatRule" + JSON.stringify(event))
	}
	const frequency: RepeatPeriodEnum = downcast(repeatRule.frequency)
	const interval = Number(repeatRule.interval)
	const isLong = isLongEvent(event, timeZone)
	let eventStartTime = new Date(getEventStart(event, timeZone))
	let eventEndTime = new Date(getEventEnd(event, timeZone))
	// Loop by the frequency step
	let repeatEndTime = null
	let endOccurrences = null
	const allDay = isAllDayEvent(event)
	// For all-day events we should rely on the local time zone or at least we must use the same zone as in getAllDayDateUTCFromZone
	// below. If they are not in sync, then daylight saving shifts may cause us to extract wrong UTC date (day in repeat rule zone and in
	// local zone may be different).
	const repeatTimeZone = allDay ? timeZone : getValidTimeZone(repeatRule.timeZone)
	if (repeatRule.endType === EndType.Count) {
		endOccurrences = Number(repeatRule.endValue)
	} else if (repeatRule.endType === EndType.UntilDate) {
		// See CalendarEventDialog for an explanation why it's needed
		if (allDay) {
			repeatEndTime = getAllDayDateForTimezone(new Date(Number(repeatRule.endValue)), timeZone)
		} else {
			repeatEndTime = new Date(Number(repeatRule.endValue))
		}
	}
	let calcStartTime = eventStartTime
	const calcDuration = allDay ? getDiffInDays(eventEndTime, eventStartTime) : eventEndTime - eventStartTime
	let calcEndTime = eventEndTime
	let iteration = 1
	while ((endOccurrences == null || iteration <= endOccurrences)
	&& (repeatEndTime == null || calcStartTime.getTime() < repeatEndTime)
	&& calcStartTime.getTime() < month.end.getTime()) {
		if (calcEndTime.getTime() >= month.start.getTime()) {
			const eventClone = clone(event)
			if (allDay) {
				eventClone.startTime = getAllDayDateUTCFromZone(calcStartTime, timeZone)
				eventClone.endTime = getAllDayDateUTCFromZone(calcEndTime, timeZone)
			} else {
				eventClone.startTime = new Date(calcStartTime)
				eventClone.endTime = new Date(calcEndTime)
			}
			if (isLong) {
				addDaysForLongEvent(events, eventClone, month, timeZone)
			} else {
				addDaysForEvent(events, eventClone, month, timeZone)
			}
		}
		calcStartTime = incrementByRepeatPeriod(eventStartTime, frequency, interval * iteration, repeatTimeZone)
		calcEndTime = allDay
			? incrementByRepeatPeriod(calcStartTime, RepeatPeriod.DAILY, calcDuration, repeatTimeZone)
			: DateTime.fromJSDate(calcStartTime).plus(calcDuration).toJSDate()
		iteration++
	}
}

export function addDaysForLongEvent(events: Map<number, Array<CalendarEvent>>, event: CalendarEvent, month: CalendarMonthTimeRange,
                                    zone: string = getTimeZone()) {
	// for long running events we create events for the month only

	// first start of event is inside month
	const eventStart = getEventStart(event, zone).getTime()
	const eventEnd = getEventEnd(event, zone).getTime()

	let calculationDate
	let eventEndInMonth

	if (eventStart >= month.start.getTime() && eventStart < month.end.getTime()) { // first: start of event is inside month
		calculationDate = getStartOfDayWithZone(new Date(eventStart), zone)
	} else if (eventStart < month.start.getTime()) { // start is before month
		calculationDate = new Date(month.start)
	} else {
		return // start date is after month end
	}

	if (eventEnd > month.start.getTime() && eventEnd <= month.end.getTime()) { //end is inside month
		eventEndInMonth = new Date(eventEnd)
	} else if (eventEnd > month.end.getTime()) { // end is after month end
		eventEndInMonth = new Date(month.end)
	} else {
		return // end is before start of month
	}

	let iterations = 0
	while (calculationDate.getTime() < eventEndInMonth) {
		insertIntoSortedArray(event, getFromMap(events, calculationDate.getTime(), () => []), eventComparator, isSameEvent)
		calculationDate = incrementByRepeatPeriod(calculationDate, RepeatPeriod.DAILY, 1, zone)
		if (iterations++ > 10000) {
			throw new Error("Run into the infinite loop, addDaysForLongEvent")
		}
	}
}


export function incrementByRepeatPeriod(date: Date, repeatPeriod: RepeatPeriodEnum, interval: number, ianaTimeZone: string): Date {
	switch (repeatPeriod) {
		case RepeatPeriod.DAILY:
			return DateTime.fromJSDate(date, {zone: ianaTimeZone}).plus({days: interval}).toJSDate()
		case RepeatPeriod.WEEKLY:
			return DateTime.fromJSDate(date, {zone: ianaTimeZone}).plus({weeks: interval}).toJSDate()
		case RepeatPeriod.MONTHLY:
			return DateTime.fromJSDate(date, {zone: ianaTimeZone}).plus({months: interval}).toJSDate()
		case RepeatPeriod.ANNUALLY:
			return DateTime.fromJSDate(date, {zone: ianaTimeZone}).plus({years: interval}).toJSDate()
		default:
			throw new Error("Unknown repeat period")
	}
}

const OCCURRENCES_SCHEDULED_AHEAD = 10

export function iterateEventOccurrences(
	now: Date,
	timeZone: string,
	eventStart: Date,
	eventEnd: Date,
	frequency: RepeatPeriodEnum,
	interval: number,
	endType: EndTypeEnum,
	endValue: number,
	alarmTrigger: AlarmIntervalEnum,
	localTimeZone: string,
	callback: (time: Date, occurrence: number) => mixed) {


	let occurrences = 0
	let futureOccurrences = 0

	const isAllDayEvent = isAllDayEventByTimes(eventStart, eventEnd)
	const calcEventStart = isAllDayEvent ? getAllDayDateForTimezone(eventStart, localTimeZone) : eventStart
	const endDate = endType === EndType.UntilDate
		? isAllDayEvent
			? getAllDayDateForTimezone(new Date(endValue), localTimeZone)
			: new Date(endValue)
		: null

	while (futureOccurrences < OCCURRENCES_SCHEDULED_AHEAD && (endType !== EndType.Count || occurrences < endValue)) {
		const occurrenceDate = incrementByRepeatPeriod(calcEventStart, frequency, interval
			* occurrences, isAllDayEvent ? localTimeZone : timeZone);

		if (endDate && occurrenceDate.getTime() >= endDate.getTime()) {
			break;
		}

		const alarmTime = calculateAlarmTime(occurrenceDate, alarmTrigger, localTimeZone);

		if (alarmTime >= now) {
			callback(alarmTime, occurrences);
			futureOccurrences++;
		}
		occurrences++;
	}
}

export function calculateAlarmTime(date: Date, interval: AlarmIntervalEnum, ianaTimeZone?: string): Date {
	let diff
	switch (interval) {
		case AlarmInterval.FIVE_MINUTES:
			diff = {minutes: 5}
			break
		case AlarmInterval.TEN_MINUTES:
			diff = {minutes: 10}
			break
		case AlarmInterval.THIRTY_MINUTES:
			diff = {minutes: 30}
			break
		case AlarmInterval.ONE_HOUR:
			diff = {hours: 1}
			break
		case AlarmInterval.ONE_DAY:
			diff = {days: 1}
			break
		case AlarmInterval.TWO_DAYS:
			diff = {days: 2}
			break
		case AlarmInterval.THREE_DAYS:
			diff = {days: 3}
			break
		case AlarmInterval.ONE_WEEK:
			diff = {weeks: 1}
			break
		default:
			diff = {}
	}
	return DateTime.fromJSDate(date, {zone: ianaTimeZone}).minus(diff).toJSDate()
}

function getValidTimeZone(zone: string, fallback: ?string): string {
	if (IANAZone.isValidZone(zone)) {
		return zone
	} else {
		if (fallback && IANAZone.isValidZone(fallback)) {
			console.warn(`Time zone ${zone} is not valid, falling back to ${fallback}`)
			return fallback
		} else {
			const actualFallback = FixedOffsetZone.instance(new Date().getTimezoneOffset()).name
			console.warn(`Fallback time zone ${zone} is not valid, falling back to ${actualFallback}`)
			return actualFallback
		}
	}
}

export function loadCalendarInfos(): Promise<Map<Id, CalendarInfo>> {
	const userId = logins.getUserController().user._id
	return load(UserTypeRef, userId)
		.then(user => {
			const calendarMemberships = user.memberships.filter(m => m.groupType === GroupType.Calendar);
			const notFoundMemberships = []
			return Promise
				.map(calendarMemberships, (membership) => Promise
					.all([
						load(CalendarGroupRootTypeRef, membership.group),
						load(GroupInfoTypeRef, membership.groupInfo),
						load(GroupTypeRef, membership.group)
					])
					.catch(NotFoundError, () => {
						notFoundMemberships.push(membership)
						return null
					})
				)
				.then((groupInstances) => {
					const calendarInfos: Map<Id, CalendarInfo> = new Map()
					groupInstances.filter(Boolean)
					              .forEach(([groupRoot, groupInfo, group]) => {
						              calendarInfos.set(groupRoot._id, {
							              groupRoot,
							              groupInfo,
							              shortEvents: [],
							              longEvents: new LazyLoaded(() => loadAll(CalendarEventTypeRef, groupRoot.longEvents), []),
							              group: group,
							              shared: !isSameId(group.user, userId)
						              })
					              })

					// cleanup inconsistent memberships
					Promise.each(notFoundMemberships, (notFoundMembership) => {
						const data = createMembershipRemoveData({user: userId, group: notFoundMembership.group})
						return serviceRequestVoid(SysService.MembershipService, HttpMethod.DELETE, data)
					})
					return calendarInfos
				})
		})
		.tap(() => m.redraw())
}


class CalendarModel {
	_notifications: Notifications;
	_scheduledNotifications: Map<string, TimeoutID>;
	/**
	 * Map from calendar event element id to the deferred object with a promise of getting CREATE event for this calendar event
	 */
	_pendingAlarmRequests: Map<string, DeferredObject<void>>;

	constructor(notifications: Notifications, eventController: EventController) {
		this._notifications = notifications
		this._scheduledNotifications = new Map()
		this._pendingAlarmRequests = new Map()
		if (!isApp()) {
			eventController.addEntityListener((updates: $ReadOnlyArray<EntityUpdateData>) => {
				this._entityEventsReceived(updates)
			})
		}
	}

	_processCalendarReplies() {
		return mailModel.getUserMailboxDetails().then((mailboxDetails) => {
			loadAll(CalendarEventUpdateTypeRef, neverNull(mailboxDetails.mailboxGroupRoot.calendarEventUpdates).list)
				.then((invites) => {
					return Promise.each(invites, (invite) => {
						return this._processCalendarReply(invite)
					})
				})
		})
	}

	_processCalendarReply(update: CalendarEventUpdate) {
		return load(FileTypeRef, update.file)
			.then((file) => worker.downloadFileContent(file))
			.then((dataFile: DataFile) => parseCalendarFile(dataFile))
			.then((parsedCalendarData) => {
				if (parsedCalendarData.method === "REPLY") {
					// Process it
					if (parsedCalendarData.contents.length > 0) {
						const replyEvent = parsedCalendarData.contents[0].event
						return worker.getEventByUid(neverNull(replyEvent.uid)).then((dbEvent) => {
							// TODO: this is not how we should find out attendee. Need to prove that it is authorized.
							const replyAttendee = replyEvent.attendees[0]
							if (dbEvent && replyAttendee) {
								const updatedEvent = clone(dbEvent)
								const dbAttendee = updatedEvent.attendees.find((a) =>
									replyAttendee.address.address === a.address.address)
								if (dbAttendee) {
									dbAttendee.status = replyAttendee.status
									console.log("updating event with reply status", updatedEvent.uid, updatedEvent._id)
									// TODO: check alarmInfo
									return worker.updateCalendarEvent(updatedEvent, [], dbEvent)
								} else {
									console.log("Attendee was not found", dbEvent._id, replyAttendee)
								}
							} else {
								console.log("event was not found", replyEvent.uid)
							}
						})
					}
				} else if (parsedCalendarData.method === "REQUEST") { // it is an initial request (if we don't have this yet) orss
					const replyEvent = parsedCalendarData.contents[0].event
					return worker.getEventByUid(neverNull(replyEvent.uid)).then((dbEvent) => {
						if (dbEvent) {
							// then it's an update
							// TODO: check alarms
							const newEvent = clone(dbEvent)
							newEvent.attendees = replyEvent.attendees
							newEvent.summary = replyEvent.summary
							newEvent.sequence = replyEvent.sequence
							console.log("Updating event", dbEvent.uid, dbEvent._id)
							return worker.updateCalendarEvent(newEvent, [], dbEvent)
						}
						// We might want to insert new invitation for the user if it's a new invite
					})
				}
			})
			.then(() => erase(update))
	}

	init(): Promise<void> {
		return this.scheduleAlarmsLocally()
		           .then(() => this._processCalendarReplies())
	}

	scheduleAlarmsLocally(): Promise<void> {
		if (this._localAlarmsEnabled()) {
			return worker.loadAlarmEvents()
			             .then((eventsWithInfos) => {
				             eventsWithInfos.forEach(({event, userAlarmInfo}) => {
					             this.scheduleUserAlarmInfo(event, userAlarmInfo)
				             })
			             })
		} else {
			return Promise.resolve()
		}
	}

	scheduleUserAlarmInfo(event: CalendarEvent, userAlarmInfo: UserAlarmInfo) {
		const repeatRule = event.repeatRule
		const localZone = getTimeZone()
		if (repeatRule) {
			let repeatTimeZone = getValidTimeZone(repeatRule.timeZone, localZone)

			let calculationLocalZone = getValidTimeZone(localZone, null)
			iterateEventOccurrences(new Date(),
				repeatTimeZone,
				event.startTime,
				event.endTime,
				downcast(repeatRule.frequency),
				Number(repeatRule.interval),
				downcast(repeatRule.endType) || EndType.Never,
				Number(repeatRule.endValue),
				downcast(userAlarmInfo.alarmInfo.trigger),
				calculationLocalZone,
				(time, occurrence) => {
					this._scheduleNotification(getElementId(userAlarmInfo) + occurrence, event, time)
				})
		} else {
			if (getEventStart(event, localZone).getTime() > Date.now()) {
				this._scheduleNotification(getElementId(userAlarmInfo), event, calculateAlarmTime(event.startTime, downcast(userAlarmInfo.alarmInfo.trigger)))
			}
		}
	}

	createEvent(newEvent: CalendarEvent, newAlarms: Array<AlarmInfo>, existingEvent: CalendarEvent,
	            groupRoot: CalendarGroupRoot): Promise<void> {
		assignEventId(newEvent, getTimeZone(), groupRoot)
		return worker.createCalendarEvent(newEvent, newAlarms, existingEvent)
	}

	_scheduleNotification(identifier: string, event: CalendarEvent, time: Date) {
		this._runAtDate(time, identifier, () => {
			const title = lang.get("reminder_label")
			const eventStart = getEventStart(event, getTimeZone())
			let dateString: string
			if (isToday(eventStart)) {
				dateString = formatTime(eventStart)
			} else {
				dateString = formatDateWithWeekdayAndTime(eventStart)
			}
			const body = `${dateString} ${event.summary}`
			return this._notifications.showNotification(title, {body}, () => {
				m.route.set("/calendar/agenda")
			})
		})
	}

	_runAtDate(date: Date, identifier: string, func: () => mixed) {
		const now = Date.now()
		const then = date.getTime()
		const diff = Math.max((then - now), 0)
		const timeoutId = diff > 0x7FFFFFFF // setTimeout limit is MAX_INT32=(2^31-1)
			? setTimeout(() => this._runAtDate(date, identifier, func), 0x7FFFFFFF)
			: setTimeout(func, diff)
		this._scheduledNotifications.set(identifier, timeoutId)
	}

	_entityEventsReceived(updates: $ReadOnlyArray<EntityUpdateData>) {
		for (let entityEventData of updates) {
			if (isUpdateForTypeRef(UserAlarmInfoTypeRef, entityEventData)) {
				if (entityEventData.operation === OperationType.CREATE) {
					const userAlarmInfoId = [entityEventData.instanceListId, entityEventData.instanceId]
					// Updates for UserAlarmInfo and CalendarEvent come in a
					// separate batches and there's a race between loading of the
					// UserAlarmInfo and creation of the event.
					// We try to load UserAlarmInfo. Then we wait until the
					// CalendarEvent is there (which might already be true)
					// and load it.
					load(UserAlarmInfoTypeRef, userAlarmInfoId).then((userAlarmInfo) => {
						const {listId, elementId} = userAlarmInfo.alarmInfo.calendarRef
						const deferredEvent = getFromMap(this._pendingAlarmRequests, elementId, defer)
						return deferredEvent.promise.then(() => {
							return load(CalendarEventTypeRef, [listId, elementId])
								.then(calendarEvent => {
									this.scheduleUserAlarmInfo(calendarEvent, userAlarmInfo)
								})
						})
					}).catch(NotFoundError, (e) => console.log(e, "Event or alarm were not found: ", entityEventData, e))
				} else if (entityEventData.operation === OperationType.DELETE) {
					this._scheduledNotifications.forEach((value, key) => {
						if (key.startsWith(entityEventData.instanceId)) {
							this._scheduledNotifications.delete(key)
							clearTimeout(value)
						}
					})
				}
			} else if (isUpdateForTypeRef(CalendarEventTypeRef, entityEventData)
				&& (entityEventData.operation === OperationType.CREATE || entityEventData.operation === OperationType.UPDATE)) {
				getFromMap(this._pendingAlarmRequests, entityEventData.instanceId, defer).resolve()
			} else if (isUpdateForTypeRef(CalendarEventUpdateTypeRef, entityEventData)
				&& entityEventData.operation === OperationType.CREATE) {
				console.log("create for invite", entityEventData)
				load(CalendarEventUpdateTypeRef, [entityEventData.instanceListId, entityEventData.instanceId])
					.then((invite) => this._processCalendarReply(invite))
					.catch(NotFoundError, (e) => {
						console.log("invite not found", [entityEventData.instanceListId, entityEventData.instanceId], e)
					})
			}
		}
	}

	_localAlarmsEnabled(): boolean {
		return !isApp() && logins.isInternalUserLoggedIn() && !logins.isEnabled(FeatureType.DisableCalendar) && client.calendarSupported()
	}
}

export const calendarModel = new CalendarModel(new Notifications(), locator.eventController)

if (replaced) {
	Object.assign(calendarModel, replaced.calendarModel)
}
