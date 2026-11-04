declare namespace Express {
  interface Request {
    user?: {
      id: string;
      userId: string;
      email: string;
      role: string;
      iat?: number;
      exp?: number;
    };
  }
}
