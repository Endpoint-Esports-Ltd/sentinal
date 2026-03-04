import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true })
  passwordHash: string;

  @Column({ nullable: true })
  avatarUrl: string;

  @Column({ default: "user" })
  role: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isVerified: boolean;

  @Column({ nullable: true })
  verifiedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  lastLoginAt: Date;

  @Column({ default: 0 })
  loginCount: number;

  @Column({ default: 0 })
  failedLoginAttempts: number;

  @Column({ default: false })
  isLocked: boolean;

  @Column({ nullable: true })
  lockedAt: Date;

  @Column({ nullable: true })
  suspendedAt: Date;

  @Column({ nullable: true })
  suspendedReason: string;

  @Column({ nullable: true })
  suspendedUntil: Date;

  @Column("simple-array", { nullable: true })
  permissions: string[];

  @Column("simple-array", { nullable: true })
  groups: string[];

  @Column("simple-array", { nullable: true })
  tags: string[];

  @Column("simple-array", { nullable: true })
  newsletterSubscriptions: string[];

  @Column({ nullable: true })
  organizationId: string;

  @Column({ nullable: true })
  phoneNumber: string;

  @Column({ nullable: true })
  bio: string;

  @Column({ nullable: true })
  website: string;

  @Column({ nullable: true })
  company: string;

  @Column({ nullable: true })
  location: string;

  @Column({ nullable: true })
  birthDate: Date;

  @Column({ nullable: true })
  subscriptionTier: string;

  @Column({ nullable: true })
  subscriptionStartedAt: Date;

  @Column({ nullable: true })
  subscriptionExpiresAt: Date;

  @Column("jsonb", { nullable: true })
  preferences: Record<string, unknown>;

  @Column("jsonb", { nullable: true })
  socialConnections: Record<string, string>;

  @Column({ nullable: true })
  passwordResetToken: string;

  @Column({ nullable: true })
  passwordResetExpires: Date;

  @Column({ nullable: true })
  passwordChangedAt: Date;
}
