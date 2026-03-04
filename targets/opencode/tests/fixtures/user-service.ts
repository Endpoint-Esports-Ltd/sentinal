// This file should trigger multiple Sentinal warnings
// It has >400 lines to trigger file length warning

import { Injectable } from "@nestjs/common";
import { UserRepository } from "./user.repository";

@Injectable()
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}

  async findAll(): Promise<User[]> {
    return this.userRepository.find();
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async create(data: CreateUserDto): Promise<User> {
    return this.userRepository.save(data);
  }

  async update(id: string, data: UpdateUserDto): Promise<User> {
    await this.userRepository.update(id, data);
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.userRepository.delete(id);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { username } });
  }

  async findByProvider(provider: string, providerId: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { provider, providerId } });
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.userRepository.update(id, { lastLoginAt: new Date() });
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.userRepository.update(id, { passwordHash });
  }

  async verifyPassword(id: string, password: string): Promise<boolean> {
    const user = await this.findById(id);
    if (!user || !user.passwordHash) return false;
    return bcrypt.compare(password, user.passwordHash);
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async findActive(): Promise<User[]> {
    return this.userRepository.find({ where: { isActive: true } });
  }

  async findInactive(): Promise<User[]> {
    return this.userRepository.find({ where: { isActive: false } });
  }

  async activateUser(id: string): Promise<void> {
    await this.userRepository.update(id, { isActive: true });
  }

  async deactivateUser(id: string): Promise<void> {
    await this.userRepository.update(id, { isActive: false });
  }

  async findByRole(role: string): Promise<User[]> {
    return this.userRepository.find({ where: { role } });
  }

  async assignRole(id: string, role: string): Promise<void> {
    await this.userRepository.update(id, { role });
  }

  async removeRole(id: string): Promise<void> {
    await this.userRepository.update(id, { role: null });
  }

  async findByOrganization(orgId: string): Promise<User[]> {
    return this.userRepository.find({ where: { organizationId: orgId } });
  }

  async assignOrganization(id: string, orgId: string): Promise<void> {
    await this.userRepository.update(id, { organizationId: orgId });
  }

  async removeOrganization(id: string): Promise<void> {
    await this.userRepository.update(id, { organizationId: null });
  }

  async count(): Promise<number> {
    return this.userRepository.count();
  }

  async countByRole(role: string): Promise<number> {
    return this.userRepository.count({ where: { role } });
  }

  async countByOrganization(orgId: string): Promise<number> {
    return this.userRepository.count({ where: { organizationId: orgId } });
  }

  async exists(id: string): Promise<boolean> {
    const count = await this.userRepository.count({ where: { id } });
    return count > 0;
  }

  async existsByEmail(email: string): Promise<boolean> {
    const count = await this.userRepository.count({ where: { email } });
    return count > 0;
  }

  async existsByUsername(username: string): Promise<boolean> {
    const count = await this.userRepository.count({ where: { username } });
    return count > 0;
  }

  async search(query: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.email LIKE :query", { query: `%${query}%` })
      .orWhere("user.username LIKE :query", { query: `%${query}%` })
      .orWhere("user.firstName LIKE :query", { query: `%${query}%` })
      .orWhere("user.lastName LIKE :query", { query: `%${query}%` })
      .getMany();
  }

  async findPaginated(page: number, limit: number): Promise<{ users: User[]; total: number }> {
    const [users, total] = await this.userRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: "DESC" },
    });
    return { users, total };
  }

  async bulkCreate(data: CreateUserDto[]): Promise<User[]> {
    return this.userRepository.save(data);
  }

  async bulkUpdate(ids: string[], data: Partial<UpdateUserDto>): Promise<void> {
    await this.userRepository.update(ids, data);
  }

  async bulkDelete(ids: string[]): Promise<void> {
    await this.userRepository.delete(ids);
  }

  async findRecentlyJoined(days: number): Promise<User[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return this.userRepository.find({
      where: { createdAt: MoreThan(since) },
      order: { createdAt: "DESC" },
    });
  }

  async findWithNoActivity(days: number): Promise<User[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return this.userRepository.find({
      where: { lastLoginAt: LessThan(since) },
      order: { lastLoginAt: "ASC" },
    });
  }

  async updateProfile(id: string, profile: ProfileUpdateDto): Promise<User> {
    await this.userRepository.update(id, profile);
    return this.findById(id);
  }

  async uploadAvatar(id: string, avatarUrl: string): Promise<void> {
    await this.userRepository.update(id, { avatarUrl });
  }

  async removeAvatar(id: string): Promise<void> {
    await this.userRepository.update(id, { avatarUrl: null });
  }

  async addPermission(id: string, permission: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");
    const permissions = user.permissions || [];
    if (!permissions.includes(permission)) {
      permissions.push(permission);
      await this.userRepository.update(id, { permissions });
    }
  }

  async removePermission(id: string, permission: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");
    const permissions = (user.permissions || []).filter((p) => p !== permission);
    await this.userRepository.update(id, { permissions });
  }

  async hasPermission(id: string, permission: string): Promise<boolean> {
    const user = await this.findById(id);
    if (!user) return false;
    return (user.permissions || []).includes(permission);
  }

  async addToGroup(id: string, groupId: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");
    const groups = user.groups || [];
    if (!groups.includes(groupId)) {
      groups.push(groupId);
      await this.userRepository.update(id, { groups });
    }
  }

  async removeFromGroup(id: string, groupId: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");
    const groups = (user.groups || []).filter((g) => g !== groupId);
    await this.userRepository.update(id, { groups });
  }

  async isInGroup(id: string, groupId: string): Promise<boolean> {
    const user = await this.findById(id);
    if (!user) return false;
    return (user.groups || []).includes(groupId);
  }

  async findByGroup(groupId: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.groups LIKE :groupId", { groupId: `%${groupId}%` })
      .getMany();
  }

  async findAdmins(): Promise<User[]> {
    return this.userRepository.find({
      where: { role: "admin" },
      order: { createdAt: "ASC" },
    });
  }

  async findModerators(): Promise<User[]> {
    return this.userRepository.find({
      where: { role: "moderator" },
      order: { createdAt: "ASC" },
    });
  }

  async findRegularUsers(): Promise<User[]> {
    return this.userRepository.find({
      where: { role: "user" },
      order: { createdAt: "DESC" },
    });
  }

  async promoteToAdmin(id: string): Promise<void> {
    await this.assignRole(id, "admin");
  }

  async demoteFromAdmin(id: string): Promise<void> {
    await this.assignRole(id, "user");
  }

  async lockAccount(id: string): Promise<void> {
    await this.userRepository.update(id, { isLocked: true, lockedAt: new Date() });
  }

  async unlockAccount(id: string): Promise<void> {
    await this.userRepository.update(id, { isLocked: false, lockedAt: null });
  }

  async isLocked(id: string): Promise<boolean> {
    const user = await this.findById(id);
    return user?.isLocked || false;
  }

  async recordFailedLogin(id: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;
    const failedAttempts = (user.failedLoginAttempts || 0) + 1;
    const isLocked = failedAttempts >= 5;
    await this.userRepository.update(id, {
      failedLoginAttempts: failedAttempts,
      isLocked,
      lockedAt: isLocked ? new Date() : null,
    });
  }

  async resetFailedLogins(id: string): Promise<void> {
    await this.userRepository.update(id, { failedLoginAttempts: 0 });
  }

  async findLocked(): Promise<User[]> {
    return this.userRepository.find({ where: { isLocked: true } });
  }

  async findUnverified(): Promise<User[]> {
    return this.userRepository.find({ where: { isVerified: false } });
  }

  async verifyUser(id: string): Promise<void> {
    await this.userRepository.update(id, { isVerified: true, verifiedAt: new Date() });
  }

  async sendVerificationEmail(id: string): Promise<void> {
    // Implementation would send email
  }

  async sendPasswordResetEmail(id: string): Promise<void> {
    // Implementation would send email
  }

  async createPasswordResetToken(id: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    await this.userRepository.update(id, {
      passwordResetToken: token,
      passwordResetExpires: new Date(Date.now() + 3600000),
    });
    return token;
  }

  async validatePasswordResetToken(id: string, token: string): Promise<boolean> {
    const user = await this.findById(id);
    if (!user || !user.passwordResetToken || !user.passwordResetExpires) {
      return false;
    }
    if (user.passwordResetExpires < new Date()) {
      return false;
    }
    return user.passwordResetToken === token;
  }

  async clearPasswordResetToken(id: string): Promise<void> {
    await this.userRepository.update(id, {
      passwordResetToken: null,
      passwordResetExpires: null,
    });
  }

  async findByPasswordResetToken(token: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { passwordResetToken: token },
    });
  }

  async changePassword(id: string, newPasswordHash: string): Promise<void> {
    await this.userRepository.update(id, {
      passwordHash: newPasswordHash,
      passwordChangedAt: new Date(),
    });
    await this.resetFailedLogins(id);
    await this.clearPasswordResetToken(id);
  }

  async findPasswordHistory(id: string): Promise<PasswordHistoryEntry[]> {
    // Would query password history table
    return [];
  }

  async isPasswordInHistory(id: string, passwordHash: string): Promise<boolean> {
    const history = await this.findPasswordHistory(id);
    return history.some((entry) => entry.passwordHash === passwordHash);
  }

  async auditLog(id: string, action: string, metadata?: Record<string, unknown>): Promise<void> {
    // Would create audit log entry
  }

  async findAuditLog(id: string): Promise<AuditLogEntry[]> {
    // Would query audit log table
    return [];
  }

  async exportUsers(): Promise<ExportResult> {
    const users = await this.findAll();
    return {
      total: users.length,
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        isActive: u.isActive,
        isVerified: u.isVerified,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
      })),
    };
  }

  async importUsers(data: ImportUserDto[]): Promise<ImportResult> {
    const results: { success: number; failed: number; errors: string[] } = {
      success: 0,
      failed: 0,
      errors: [],
    };

    for (const item of data) {
      try {
        await this.create(item);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to import ${item.email}: ${error}`);
      }
    }

    return results;
  }

  async mergeUsers(sourceId: string, targetId: string): Promise<User> {
    const source = await this.findById(sourceId);
    const target = await this.findById(targetId);

    if (!source || !target) {
      throw new NotFoundException("One or both users not found");
    }

    const merged = {
      ...target,
      email: target.email,
      firstName: source.firstName || target.firstName,
      lastName: source.lastName || target.lastName,
    };

    await this.userRepository.update(targetId, merged);
    await this.delete(sourceId);

    return this.findById(targetId);
  }

  async anonymizeUser(id: string): Promise<void> {
    await this.userRepository.update(id, {
      email: `deleted-${id}@example.com`,
      username: `deleted-${id}`,
      firstName: "Deleted",
      lastName: "User",
      avatarUrl: null,
    });
  }

  async deleteUser(id: string): Promise<void> {
    await this.anonymizeUser(id);
    await this.deactivateUser(id);
  }

  async hardDeleteUser(id: string): Promise<void> {
    await this.delete(id);
  }

  async restoreUser(id: string): Promise<void> {
    await this.activateUser(id);
  }

  async findDeleted(): Promise<User[]> {
    return this.userRepository.find({
      where: { email: Like("deleted-%") },
    });
  }

  async getUserStats(id: string): Promise<UserStats> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      loginCount: user.loginCount || 0,
      failedLoginAttempts: user.failedLoginAttempts || 0,
    };
  }

  async updateLoginCount(id: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;
    await this.userRepository.update(id, {
      loginCount: (user.loginCount || 0) + 1,
      lastLoginAt: new Date(),
    });
  }

  async findTopUsers(limit: number): Promise<User[]> {
    return this.userRepository.find({
      order: { loginCount: "DESC" },
      take: limit,
    });
  }

  async findUsersWithoutRole(): Promise<User[]> {
    return this.userRepository.find({
      where: { role: IsNull() },
    });
  }

  async assignDefaultRole(id: string): Promise<void> {
    await this.assignRole(id, "user");
  }

  async findSuspended(): Promise<User[]> {
    return this.userRepository.find({
      where: { isActive: false },
    });
  }

  async suspendUser(id: string, reason: string, duration?: number): Promise<void> {
    await this.userRepository.update(id, {
      isActive: false,
      suspendedAt: new Date(),
      suspendedReason: reason,
      suspendedUntil: duration ? new Date(Date.now() + duration) : null,
    });
  }

  async unsuspendUser(id: string): Promise<void> {
    await this.userRepository.update(id, {
      isActive: true,
      suspendedAt: null,
      suspendedReason: null,
      suspendedUntil: null,
    });
  }

  async isSuspended(id: string): Promise<boolean> {
    const user = await this.findById(id);
    if (!user || !user.suspendedUntil) return false;
    if (user.suspendedUntil < new Date()) {
      await this.unsuspendUser(id);
      return false;
    }
    return true;
  }

  async findExpiredSubscriptions(): Promise<User[]> {
    const now = new Date();
    return this.userRepository.find({
      where: { subscriptionExpiresAt: LessThan(now) },
    });
  }

  async extendSubscription(id: string, days: number): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const currentExpiry = user.subscriptionExpiresAt || new Date();
    const newExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);

    await this.userRepository.update(id, { subscriptionExpiresAt: newExpiry });
  }

  async cancelSubscription(id: string): Promise<void> {
    await this.userRepository.update(id, {
      subscriptionExpiresAt: null,
      subscriptionTier: null,
    });
  }

  async upgradeSubscription(id: string, tier: string): Promise<void> {
    await this.userRepository.update(id, {
      subscriptionTier: tier,
      subscriptionStartedAt: new Date(),
    });
  }

  async findBySubscriptionTier(tier: string): Promise<User[]> {
    return this.userRepository.find({ where: { subscriptionTier: tier } });
  }

  async findWithExpiringSubscriptions(days: number): Promise<User[]> {
    const until = new Date();
    until.setDate(until.getDate() + days);
    return this.userRepository.find({
      where: {
        subscriptionExpiresAt: MoreThan(new Date()).and(
          LessThan(until),
        ),
      },
    });
  }

  async sendSubscriptionExpiryWarning(id: string): Promise<void> {
    // Would send email
  }

  async getSubscriptionStatus(id: string): Promise<SubscriptionStatus> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    if (!user.subscriptionExpiresAt || user.subscriptionExpiresAt < new Date()) {
      return { active: false, tier: user.subscriptionTier, expiresAt: null };
    }

    return {
      active: true,
      tier: user.subscriptionTier,
      expiresAt: user.subscriptionExpiresAt,
    };
  }

  async validateSubscription(id: string): Promise<boolean> {
    const status = await this.getSubscriptionStatus(id);
    return status.active;
  }

  async findUsersByDateRange(startDate: Date, endDate: Date): Promise<User[]> {
    return this.userRepository.find({
      where: {
        createdAt: MoreThan(startDate).and(LessThan(endDate)),
      },
      order: { createdAt: "DESC" },
    });
  }

  async getUserCountByDate(days: number): Promise<{ date: Date; count: number }[]> {
    // Would aggregate user creation by date
    return [];
  }

  async getUserCountByRole(): Promise<{ role: string; count: number }[]> {
    // Would aggregate user count by role
    return [];
  }

  async getActiveUserCount(): Promise<number> {
    return this.userRepository.count({ where: { isActive: true } });
  }

  async getVerifiedUserCount(): Promise<number> {
    return this.userRepository.count({ where: { isVerified: true } });
  }

  async getUserGrowthRate(days: number): Promise<number> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const totalUsers = await this.userRepository.count();
    const newUsers = await this.userRepository.count({
      where: { createdAt: MoreThan(startDate) },
    });

    return (newUsers / totalUsers) * 100;
  }

  async getMostActiveUsers(limit: number): Promise<User[]> {
    return this.userRepository.find({
      order: { loginCount: "DESC", lastLoginAt: "DESC" },
      take: limit,
    });
  }

  async getUserActivityReport(startDate: Date, endDate: Date): Promise<ActivityReport> {
    const users = await this.findUsersByDateRange(startDate, endDate);
    return {
      total: users.length,
      active: users.filter((u) => u.isActive).length,
      verified: users.filter((u) => u.isVerified).length,
      byRole: {},
    };
  }

  async findUsersNeedingAttention(): Promise<User[]> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return this.userRepository
      .createQueryBuilder("user")
      .where("user.isActive = :active", { active: true })
      .andWhere("user.lastLoginAt < :date", { date: thirtyDaysAgo })
      .orWhere("user.failedLoginAttempts >= :attempts", { attempts: 3 })
      .getMany();
  }

  async sendReEngagementEmail(id: string): Promise<void> {
    // Would send email
  }

  async tagUser(id: string, tag: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const tags = user.tags || [];
    if (!tags.includes(tag)) {
      tags.push(tag);
      await this.userRepository.update(id, { tags });
    }
  }

  async untagUser(id: string, tag: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const tags = (user.tags || []).filter((t) => t !== tag);
    await this.userRepository.update(id, { tags });
  }

  async findUsersByTag(tag: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.tags LIKE :tag", { tag: `%${tag}%` })
      .getMany();
  }

  async getAllTags(): Promise<string[]> {
    const users = await this.findAll();
    const tagSet = new Set<string>();
    users.forEach((u) => (u.tags || []).forEach((t) => tagSet.add(t)));
    return Array.from(tagSet);
  }

  async subscribeToNewsletter(id: string, newsletter: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const subscriptions = user.newsletterSubscriptions || [];
    if (!subscriptions.includes(newsletter)) {
      subscriptions.push(newsletter);
      await this.userRepository.update(id, { newsletterSubscriptions: subscriptions });
    }
  }

  async unsubscribeFromNewsletter(id: string, newsletter: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const subscriptions = (user.newsletterSubscriptions || []).filter((n) => n !== newsletter);
    await this.userRepository.update(id, { newsletterSubscriptions: subscriptions });
  }

  async findSubscribedToNewsletter(newsletter: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.newsletterSubscriptions LIKE :newsletter", { newsletter: `%${newsletter}%` })
      .getMany();
  }

  async setPreferences(id: string, preferences: UserPreferences): Promise<void> {
    await this.userRepository.update(id, { preferences });
  }

  async getPreferences(id: string): Promise<UserPreferences> {
    const user = await this.findById(id);
    return user?.preferences || {};
  }

  async updateLocale(id: string, locale: string): Promise<void> {
    await this.setPreferences(id, { locale });
  }

  async updateTimezone(id: string, timezone: string): Promise<void> {
    await this.setPreferences(id, { timezone });
  }

  async updateTheme(id: string, theme: string): Promise<void> {
    await this.setPreferences(id, { theme });
  }

  async findByLocale(locale: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.preferences->>'locale' = :locale", { locale })
      .getMany();
  }

  async findByTimezone(timezone: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.preferences->>'timezone' = :timezone", { timezone })
      .getMany();
  }

  async findByTheme(theme: string): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.preferences->>'theme' = :theme", { theme })
      .getMany();
  }

  async addSocialConnection(id: string, provider: string, profileId: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const connections = user.socialConnections || {};
    connections[provider] = profileId;
    await this.userRepository.update(id, { socialConnections: connections });
  }

  async removeSocialConnection(id: string, provider: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const connections = { ...(user.socialConnections || {}) };
    delete connections[provider];
    await this.userRepository.update(id, { socialConnections: connections });
  }

  async getSocialConnections(id: string): Promise<Record<string, string>> {
    const user = await this.findById(id);
    return user?.socialConnections || {};
  }

  async hasSocialConnection(id: string, provider: string): Promise<boolean> {
    const connections = await this.getSocialConnections(id);
    return !!connections[provider];
  }

  async findBySocialConnection(provider: string, profileId: string): Promise<User | null> {
    const users = await this.userRepository.find();
    return users.find((u) => u.socialConnections?.[provider] === profileId) || null;
  }

  async mergeSocialConnections(sourceId: string, targetId: string): Promise<void> {
    const source = await this.findById(sourceId);
    const target = await this.findById(targetId);

    if (!source || !target) {
      throw new NotFoundException("One or both users not found");
    }

    const merged = { ...(target.socialConnections || {}), ...(source.socialConnections || {}) };
    await this.userRepository.update(targetId, { socialConnections: merged });
    await this.removeSocialConnection(sourceId, "all");
  }

  async getConnectedAccounts(id: string): Promise<string[]> {
    const connections = await this.getSocialConnections(id);
    return Object.keys(connections);
  }

  async isFullyConnected(id: string): Promise<boolean> {
    const connected = await this.getConnectedAccounts(id);
    const required = ["google", "github", "twitter"];
    return required.every((provider) => connected.includes(provider));
  }

  async findUsersWithCompleteProfiles(): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.firstName IS NOT NULL")
      .andWhere("user.lastName IS NOT NULL")
      .andWhere("user.avatarUrl IS NOT NULL")
      .andWhere("user.isVerified = :verified", { verified: true })
      .getMany();
  }

  async findUsersWithIncompleteProfiles(): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.firstName IS NULL OR user.lastName IS NULL OR user.avatarUrl IS NULL")
      .getMany();
  }

  async suggestProfileCompletion(id: string): Promise<string[]> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const suggestions: string[] = [];
    if (!user.firstName) suggestions.push("Add your first name");
    if (!user.lastName) suggestions.push("Add your last name");
    if (!user.avatarUrl) suggestions.push("Upload a profile picture");
    if (!user.isVerified) suggestions.push("Verify your email address");

    return suggestions;
  }

  async calculateUserScore(id: string): Promise<number> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");

    let score = 0;
    if (user.isActive) score += 20;
    if (user.isVerified) score += 20;
    if (user.firstName && user.lastName) score += 10;
    if (user.avatarUrl) score += 10;
    if (user.phoneNumber) score += 10;
    if ((user.socialConnections || {}).google) score += 10;
    if ((user.socialConnections || {}).github) score += 10;
    if (user.loginCount && user.loginCount > 10) score += 10;

    return score;
  }

  async rankUsersByScore(): Promise<{ user: User; score: number }[]> {
    const users = await this.findAll();
    const ranked = await Promise.all(
      users.map(async (user) => ({
        user,
        score: await this.calculateUserScore(user.id),
      })),
    );
    return ranked.sort((a, b) => b.score - a.score);
  }

  async getLeaderboard(limit: number): Promise<{ user: User; score: number }[]> {
    const ranked = await this.rankUsersByScore();
    return ranked.slice(0, limit);
  }
}
