import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { GetServerSidePropsContext } from "next";
import { JSONObject } from "superjson/dist/types";

import { getLocationLabels } from "@calcom/app-store/utils";
import {
  getDefaultEvent,
  getDynamicEventName,
  getGroupName,
  getUsernameList,
} from "@calcom/lib/defaultEvents";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { RecurringEvent } from "@calcom/types/Calendar";

import { asStringOrThrow, asStringOrNull } from "@lib/asStringOrNull";
import getBooking, { GetBookingType } from "@lib/getBooking";
import prisma from "@lib/prisma";
import { inferSSRProps } from "@lib/types/inferSSRProps";

import BookingPage from "@components/booking/pages/BookingPage";

import { ssrInit } from "@server/lib/ssr";

dayjs.extend(utc);
dayjs.extend(timezone);

export type BookPageProps = inferSSRProps<typeof getServerSideProps>;

export default function Book(props: BookPageProps) {
  const { t } = useLocale();
  const locationLabels = getLocationLabels(t);

  return props.away ? (
    <div className="h-screen dark:bg-neutral-900">
      <main className="mx-auto max-w-3xl px-4 py-24">
        <div className="space-y-6" data-testid="event-types">
          <div className="overflow-hidden rounded-sm border dark:border-gray-900">
            <div className="p-8 text-center text-gray-400 dark:text-white">
              <h2 className="font-cal mb-2 text-3xl text-gray-600 dark:text-white">
                😴{" " + t("user_away")}
              </h2>
              <p className="mx-auto max-w-md">{t("user_away_description")}</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  ) : props.isDynamicGroupBooking && !props.profile.allowDynamicBooking ? (
    <div className="h-screen dark:bg-neutral-900">
      <main className="mx-auto max-w-3xl px-4 py-24">
        <div className="space-y-6" data-testid="event-types">
          <div className="overflow-hidden rounded-sm border dark:border-gray-900">
            <div className="p-8 text-center text-gray-400 dark:text-white">
              <h2 className="font-cal mb-2 text-3xl text-gray-600 dark:text-white">
                {" " + t("unavailable")}
              </h2>
              <p className="mx-auto max-w-md">{t("user_dynamic_booking_disabled")}</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  ) : (
    <BookingPage {...props} locationLabels={locationLabels} />
  );
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const ssr = await ssrInit(context);
  const usernameList = getUsernameList(asStringOrThrow(context.query.user as string));
  const eventTypeSlug = context.query.slug as string;
  const recurringEventCountQuery = asStringOrNull(context.query.count);
  const users = await prisma.user.findMany({
    where: {
      username: {
        in: usernameList,
      },
    },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      bio: true,
      avatar: true,
      theme: true,
      brandColor: true,
      darkBrandColor: true,
      allowDynamicBooking: true,
      away: true,
    },
  });

  if (!users.length) return { notFound: true };
  const [user] = users;
  const isDynamicGroupBooking = users.length > 1;

  // Dynamic Group link doesn't need a type but it must have a slug
  if ((!isDynamicGroupBooking && !context.query.type) || (isDynamicGroupBooking && !eventTypeSlug)) {
    return { notFound: true };
  }

  const eventTypeRaw =
    usernameList.length > 1
      ? getDefaultEvent(eventTypeSlug)
      : await prisma.eventType.findUnique({
          where: {
            id: parseInt(asStringOrThrow(context.query.type)),
          },
          select: {
            id: true,
            title: true,
            slug: true,
            description: true,
            length: true,
            locations: true,
            customInputs: true,
            periodType: true,
            periodDays: true,
            periodStartDate: true,
            periodEndDate: true,
            recurringEvent: true,
            metadata: true,
            periodCountCalendarDays: true,
            price: true,
            currency: true,
            disableGuests: true,
            seatsPerTimeSlot: true,
            users: {
              select: {
                id: true,
                username: true,
                name: true,
                email: true,
                bio: true,
                avatar: true,
                theme: true,
              },
            },
          },
        });

  if (!eventTypeRaw) return { notFound: true };

  const credentials = await prisma.credential.findMany({
    where: {
      userId: {
        in: users.map((user) => user.id),
      },
    },
    select: {
      id: true,
      type: true,
      key: true,
    },
  });

  const web3Credentials = credentials.find((credential) => credential.type.includes("_web3"));

  const eventType = {
    ...eventTypeRaw,
    metadata: (eventTypeRaw.metadata || {}) as JSONObject,
    recurringEvent: (eventTypeRaw.recurringEvent || {}) as RecurringEvent,
    isWeb3Active:
      web3Credentials && web3Credentials.key
        ? (((web3Credentials.key as JSONObject).isWeb3Active || false) as boolean)
        : false,
  };

  const eventTypeObject = [eventType].map((e) => {
    return {
      ...e,
      periodStartDate: e.periodStartDate?.toString() ?? null,
      periodEndDate: e.periodEndDate?.toString() ?? null,
    };
  })[0];

  let booking: GetBookingType | null = null;
  if (context.query.rescheduleUid || context.query.bookingUid) {
    booking = await getBooking(
      prisma,
      context.query.rescheduleUid
        ? (context.query.rescheduleUid as string)
        : (context.query.bookingUid as string)
    );
  }

  const dynamicNames = isDynamicGroupBooking
    ? users.map((user) => {
        return user.name || "";
      })
    : [];

  const profile = isDynamicGroupBooking
    ? {
        name: getGroupName(dynamicNames),
        image: null,
        slug: eventTypeSlug,
        theme: null,
        brandColor: "",
        darkBrandColor: "",
        allowDynamicBooking: !users.some((user) => {
          return !user.allowDynamicBooking;
        }),
        eventName: getDynamicEventName(dynamicNames, eventTypeSlug),
      }
    : {
        name: user.name || user.username,
        image: user.avatar,
        slug: user.username,
        theme: user.theme,
        brandColor: user.brandColor,
        darkBrandColor: user.darkBrandColor,
        eventName: null,
      };

  // Checking if number of recurring event ocurrances is valid against event type configuration
  const recurringEventCount =
    (eventType.recurringEvent?.count &&
      recurringEventCountQuery &&
      (parseInt(recurringEventCountQuery) <= eventType.recurringEvent.count
        ? recurringEventCountQuery
        : eventType.recurringEvent.count)) ||
    null;

  return {
    props: {
      away: user.away,
      profile,
      eventType: eventTypeObject,
      booking,
      recurringEventCount,
      trpcState: ssr.dehydrate(),
      isDynamicGroupBooking,
      hasHashedBookingLink: false,
      hashedLink: null,
    },
  };
}
