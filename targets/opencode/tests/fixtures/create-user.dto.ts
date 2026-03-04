// This DTO should trigger a validation warning
// Add validation decorators

export class CreateUserDto {
  name: string;
  email: string;
  password: string;
  avatar?: string;
  phoneNumber?: string;
  bio?: string;
  website?: string;
  company?: string;
  location?: string;
  birthDate?: Date;
}
