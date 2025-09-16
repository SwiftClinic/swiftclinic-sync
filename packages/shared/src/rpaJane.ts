export interface JaneContextOptions {
  headless?: boolean;
  selectors?: {
    gridContainer?: string;
    searchInput?: string;
    appointmentCell?: string;
    moveToParkingButton?: string;
    cancelButton?: string;
  };
}

export interface LocateParams {
  practitioner_key: string;
  start_iso: string;
  end_iso: string;
  patient_text?: string;
}

export class JaneRPA {
  constructor(private opts: JaneContextOptions) {}

  async initSession(clinic_id: string): Promise<void> {
    // TODO: login/session handling using stored creds
  }

  async locateAppointment(p: LocateParams): Promise<boolean> {
    // TODO: use selectors to find appointment in grid; return true if found
    return true;
  }

  async moveToParking(parking_resource_key: string): Promise<void> {
    // TODO: drag-and-drop or command to move appointment to parking
  }

  async cancelParked(): Promise<void> {
    // TODO: cancel the appointment currently selected (parked)
  }

  async close(): Promise<void> {}
}
