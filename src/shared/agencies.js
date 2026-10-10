// The two agencies: realtime feeds (read by the Worker) and static GTFS
// (read by the build script). Route and vehicle ids are prefixed with the
// agency ("metro:1", "tank:1") because the two reuse the same route numbers.

const METRO_RT = "https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService";
const TANK_RT = "https://tank.rideralerts.com/InfoPoint";

export const AGENCIES = {
  metro: {
    name: "Metro",
    gtfs: "https://www.go-metro.com/wp-content/uploads/2024/12/google_transit-1.zip",
    feeds: {
      vehicles: `${METRO_RT}/vehicle/vehiclepositions.pb`,
      trips: `${METRO_RT}/tripupdate/tripupdates.pb`,
      alerts: `${METRO_RT}/alert/alerts.pb`,
    },
  },
  tank: {
    name: "TANK",
    gtfs: `${TANK_RT}/GTFS-Zip.ashx`,
    feeds: {
      vehicles: `${TANK_RT}/GTFS-Realtime.ashx?Type=VehiclePosition`,
      trips: `${TANK_RT}/GTFS-Realtime.ashx?Type=TripUpdate`,
      alerts: `${TANK_RT}/GTFS-Realtime.ashx?Type=Alert`,
    },
  },
};

export const tag = (agency, id) => (id == null ? id : `${agency}:${id}`);
