import { BookingStatus, ReminderType } from "@prisma/client";
import dayjs from "dayjs";
import type { NextApiRequest, NextApiResponse } from "next";

import { sendOrganizerRequestReminderEmail } from "@calcom/emails";
import { isPrismaObjOrUndefined } from "@calcom/lib";
import prisma, { bookingMinimalSelect } from "@calcom/prisma";
import type { CalendarEvent } from "@calcom/types/Calendar";

import { getTranslation } from "@server/lib/i18n";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiKey = req.headers.authorization || req.query.apiKey;
  if (process.env.CRON_API_KEY !== apiKey) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ message: "Invalid method" });
    return;
  }

  const reminderIntervalMinutes = [48 * 60, 24 * 60, 3 * 60];
  let notificationsSent = 0;
  for (const interval of reminderIntervalMinutes) {
    const bookings = await prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING,
        createdAt: {
          lte: dayjs().add(-interval, "minutes").toDate(),
        },
      },
      select: {
        ...bookingMinimalSelect,
        location: true,
        user: {
          select: {
            email: true,
            name: true,
            username: true,
            locale: true,
            timeZone: true,
            destinationCalendar: true,
          },
        },
        uid: true,
        destinationCalendar: true,
      },
    });

    const reminders = await prisma.reminderMail.findMany({
      where: {
        reminderType: ReminderType.PENDING_BOOKING_CONFIRMATION,
        referenceId: {
          in: bookings.map((b) => b.id),
        },
        elapsedMinutes: {
          gte: interval,
        },
      },
    });

    for (const booking of bookings.filter((b) => !reminders.some((r) => r.referenceId == b.id))) {
      const { user } = booking;
      const name = user?.name || user?.username;
      if (!user || !name || !user.timeZone) {
        console.error(`Booking ${booking.id} is missing required properties for booking reminder`, { user });
        continue;
      }

      const tOrganizer = await getTranslation(user.locale ?? "en", "common");

      const attendeesListPromises = booking.attendees.map(async (attendee) => {
        return {
          name: attendee.name,
          email: attendee.email,
          timeZone: attendee.timeZone,
          language: {
            translate: await getTranslation(attendee.locale ?? "en", "common"),
            locale: attendee.locale ?? "en",
          },
        };
      });

      const attendeesList = await Promise.all(attendeesListPromises);

      const evt: CalendarEvent = {
        type: booking.title,
        title: booking.title,
        description: booking.description || undefined,
        customInputs: isPrismaObjOrUndefined(booking.customInputs),
        location: booking.location ?? "",
        startTime: booking.startTime.toISOString(),
        endTime: booking.endTime.toISOString(),
        organizer: {
          email: user.email,
          name,
          timeZone: user.timeZone,
          language: { translate: tOrganizer, locale: user.locale ?? "en" },
        },
        attendees: attendeesList,
        uid: booking.uid,
        destinationCalendar: booking.destinationCalendar || user.destinationCalendar,
      };

      await sendOrganizerRequestReminderEmail(evt);

      await prisma.reminderMail.create({
        data: {
          referenceId: booking.id,
          reminderType: ReminderType.PENDING_BOOKING_CONFIRMATION,
          elapsedMinutes: interval,
        },
      });
      notificationsSent++;
    }
  }
  res.status(200).json({ notificationsSent });
}
