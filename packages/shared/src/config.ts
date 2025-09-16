export interface ParkingPolicy {
  dummy_resource_key: string; // e.g., Parking column/resource
  max_dwell_seconds: number; // how long an appointment can remain parked
}

export interface ClinicSelectors {
  // Loose placeholders for RPA selectors; per-clinic can override
  gridContainer?: string;
  searchInput?: string;
  appointmentCell?: string;
  moveToParkingButton?: string;
  cancelButton?: string;
}

export interface ClinicConfig {
  clinic_id: string;
  timezone: string;
  parking: ParkingPolicy;
  selectors?: ClinicSelectors;
  csp:
    | {
        host: string;
        apiKey: string;
      }
    | null;
}
